import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch, type Response } from 'undici';

/** приватные/служебные адреса — исходящие запросы панели не должны ходить внутрь её сети */
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) проверяем как IPv4
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
  if (mapped) return isPrivateIp(mapped[1]!);
  return v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') || v6.startsWith('fe9') ||
    v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

const forbidden = (host: string): Error => new Error(`${host} ведёт в приватную сеть — запрос отклонён`);

/**
 * lookup для сокета: резолвит имя и отказывает, если хоть один адрес приватный.
 * Проверка живёт в самом соединении, а не «до» него: между отдельной проверкой и коннектом
 * DNS мог бы подменить ответ (rebinding), а редирект — увести на внутренний адрес.
 * Здесь же каждый хоп редиректа резолвится и проверяется заново.
 */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns
    .lookup(hostname, { all: true, family: options.family, hints: options.hints })
    .then((addrs) => {
      if (addrs.length === 0) return callback(new Error(`${hostname}: адрес не найден`), []);
      if (addrs.some((a) => isPrivateIp(a.address))) return callback(forbidden(hostname), []);
      if (options.all) callback(null, addrs);
      else callback(null, addrs[0]!.address, addrs[0]!.family);
    })
    .catch((err: NodeJS.ErrnoException) => callback(err, []));
};

const baseConnect = buildConnector({ lookup: guardedLookup });
const guardedConnect: buildConnector.connector = (opts, callback) => {
  // IP-литерал сокет подключает без lookup — проверяем его здесь
  if (net.isIP(opts.hostname) && isPrivateIp(opts.hostname)) return callback(forbidden(opts.hostname), null);
  return baseConnect(opts, callback);
};

/** диспетчер undici, который соединяется только с публичными адресами */
export const publicOnlyDispatcher = new Agent({ connect: guardedConnect });

type FetchInit = NonNullable<Parameters<typeof undiciFetch>[1]>;

/** fetch по URL, который задаём не мы (подписки, фавиконки провайдеров): только к публичным адресам */
export async function fetchPublic(url: string, init?: Omit<FetchInit, 'dispatcher'>): Promise<Response> {
  try {
    return await undiciFetch(url, { ...init, dispatcher: publicOnlyDispatcher });
  } catch (e) {
    // undici прячет причину в cause за общим «fetch failed» — наружу нужна она:
    // «… ведёт в приватную сеть», «connect ECONNREFUSED» и т.п.
    const cause = (e as Error & { cause?: unknown }).cause;
    throw cause instanceof Error ? cause : e;
  }
}

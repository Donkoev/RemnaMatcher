import dns from 'node:dns/promises';
import net from 'node:net';

/** приватные/служебные адреса — прокси иконок не должен ходить внутрь сети панели */
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

/** домен годится для прямого запроса: не IP-литерал и резолвится только в публичные адреса */
export async function resolvesToPublic(domain: string): Promise<boolean> {
  if (net.isIP(domain)) return false;
  try {
    const addrs = await dns.lookup(domain, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

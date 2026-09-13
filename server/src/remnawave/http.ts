import type {
  HwidDevice,
  NodeSessions,
  PanelApiVersion,
  RemnaEnforcer,
  RemnaNode,
  RemnaReader,
  RemnaUser,
  TorrentReport,
  UserRef,
} from './types.js';

/**
 * Общее знание о версии API панели: 2.7.x и 3.x различаются путями сессий,
 * форматом drop и идентификаторами юзеров в действиях (uuid против числового id).
 * Версия определяется по ответу списка юзеров и уточняется при 404 на лету.
 */
export class PanelVersionState {
  v: PanelApiVersion | null = null;

  set(v: PanelApiVersion): void {
    if (this.v !== v) {
      this.v = v;
      console.log(`[remna] версия API панели: ${v === '2' ? '2.7.x' : '3.x'}`);
    }
  }
}

/** ошибка HTTP-ответа панели: статус нужен, чтобы отличать «нет такой ручки» от «панель перегружена» */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** из Retry-After при 429/503; 0 — заголовка не было */
    readonly retryAfterMs: number,
  ) {
    super(message);
  }
}

const is404 = (err: unknown): boolean => err instanceof Error && err.message.includes('HTTP 404');
/** временный сбой: панель или прокси перед ней просят подождать либо упали на этом запросе */
const isTransient = (err: unknown): boolean =>
  !(err instanceof ApiError) || err.status === 429 || err.status === 408 || err.status >= 500;
/** причина сбоя одной строкой, без длинного тела ответа */
const reasonOf = (err: unknown): string => {
  if (err instanceof ApiError) return `панель ответила HTTP ${err.status}`;
  const msg = err instanceof Error ? err.message : String(err);
  if (/abort|timeout/i.test(msg)) return 'панель не ответила за 30 с';
  return msg.slice(0, 120);
};

interface HttpOpts {
  baseUrl: string;
  token: string;
  /** секрет nginx-защиты в формате key=value */
  secret?: string;
}

// зависшая панель не должна подвешивать цикл коллектора навсегда: страница из 500 юзеров
// и результат job'а укладываются в секунды, 30 с — с большим запасом
const API_TIMEOUT_MS = 30_000;

async function api<T>(opts: HttpOpts, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let url = `${opts.baseUrl.replace(/\/+$/, '')}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.token}`,
    'Content-Type': 'application/json',
  };
  if (opts.secret) {
    url += (url.includes('?') ? '&' : '?') + opts.secret;
    headers.Cookie = opts.secret;
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new ApiError(
      `Remnawave API ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`,
      res.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 0,
    );
  }
  return (await res.json()) as T;
}

/**
 * Запуск job на ноде с повтором при временном сбое (429/5xx/обрыв): один такой ответ панели
 * не должен списывать ноду на весь круг. Retry-After уважаем, иначе пауза растёт 2 → 5 → 10 с.
 */
async function startJobWithRetry(opts: HttpOpts, path: string): Promise<string> {
  const backoffMs = [2000, 5000, 10_000];
  for (let attempt = 0; ; attempt++) {
    try {
      const started = await api<{ response: { jobId: string } }>(opts, 'POST', path, {});
      return started.response.jobId;
    } catch (err) {
      if (attempt >= backoffMs.length || !isTransient(err)) throw err;
      const wait = err instanceof ApiError && err.retryAfterMs > 0 ? err.retryAfterMs : backoffMs[attempt]!;
      await sleep(Math.min(wait, 30_000));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// размер страницы списка юзеров: обе ветки панели принимают до 1000
const USERS_PAGE = 1000;

/** юзер, как его отдаёт список панели: трафик вложен, uuid есть только в 2.7.x */
type RawUser = Omit<RemnaUser, 'usedTrafficBytes' | 'onlineAt' | 'expireAt' | 'uuid'> & {
  expireAt: string | null;
  userTraffic: { usedTrafficBytes: number; onlineAt: string | null };
  /** 2.7.x отдаёт uuid; в новых версиях панели его в списке нет — есть vlessUuid */
  uuid?: string;
  vlessUuid?: string;
};

function mapUser(u: RawUser): RemnaUser {
  return {
    id: u.id,
    // фолбэк для панелей новее 2.7.x, где uuid в списке юзеров отсутствует
    uuid: u.uuid ?? u.vlessUuid ?? u.shortUuid,
    shortUuid: u.shortUuid,
    username: u.username,
    status: u.status,
    telegramId: u.telegramId,
    email: u.email,
    tag: u.tag,
    expireAt: u.expireAt,
    trafficLimitBytes: u.trafficLimitBytes ?? 0,
    hwidDeviceLimit: u.hwidDeviceLimit ?? null,
    subscriptionUrl: u.subscriptionUrl ?? null,
    usedTrafficBytes: u.userTraffic?.usedTrafficBytes ?? 0,
    onlineAt: u.userTraffic?.onlineAt ?? null,
    description: u.description ?? null,
  };
}

/**
 * Читающий клиент. Здесь нет ни одного вызова, меняющего состояние панели:
 * fetch-users-ips — это тот же job, который запускает страница «Обозреватель сессий».
 */
export class HttpRemnaReader implements RemnaReader {
  constructor(
    private opts: HttpOpts,
    private ver: PanelVersionState = new PanelVersionState(),
  ) {}

  async getNodes(): Promise<RemnaNode[]> {
    const data = await api<{ response: RemnaNode[] }>(this.opts, 'GET', '/api/nodes');
    return data.response;
  }

  async getAllUsers(): Promise<RemnaUser[]> {
    // 3.x отдаёт юзеров keyset-курсором — без OFFSET, который на десятках тысяч строк
    // с каждой страницей всё медленнее; на 2.7.x и до детекта версии — постранично
    if (this.ver.v === '3') {
      try {
        return await this.getAllUsersByCursor();
      } catch (err) {
        // ранняя 3.x без /users/stream, сбой сети или странный курсор — постраничный путь надёжнее
        console.warn(`[remna] /api/users/stream не сработал (${err instanceof Error ? err.message : String(err)}) — читаю постранично`);
      }
    }
    return this.getAllUsersByOffset();
  }

  private async getAllUsersByOffset(): Promise<RemnaUser[]> {
    const users: RemnaUser[] = [];
    for (let start = 0; ; start += USERS_PAGE) {
      const data = await api<{ response: { total: number; users: RawUser[] } }>(
        this.opts,
        'GET',
        `/api/users/?start=${start}&size=${USERS_PAGE}`,
      );
      // детект версии панели: 2.7.x отдаёт uuid юзера в списке, 3.x — нет
      const first = data.response.users[0];
      if (first) this.ver.set(first.uuid !== undefined ? '2' : '3');
      for (const u of data.response.users) users.push(mapUser(u));
      if (users.length >= data.response.total || data.response.users.length === 0) break;
    }
    return users;
  }

  private async getAllUsersByCursor(): Promise<RemnaUser[]> {
    const users: RemnaUser[] = [];
    let cursor: string | null = null;
    for (let page = 0; ; page++) {
      const query = `size=${USERS_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data: { response: { users: RawUser[]; nextCursor: string | null; hasMore: boolean } } = await api(
        this.opts,
        'GET',
        `/api/users/stream?${query}`,
      );
      for (const u of data.response.users) users.push(mapUser(u));
      const next = data.response.nextCursor;
      if (!data.response.hasMore || !next || data.response.users.length === 0) break;
      // страховка от зацикливания: курсор обязан двигаться, а страниц не бывает тысячами
      if (next === cursor || page > 5000) throw new Error('курсор не движется');
      cursor = next;
    }
    return users;
  }

  async getAllHwidDevices(start: number, size: number): Promise<{ devices: HwidDevice[]; total: number }> {
    const data = await api<{ response: { devices: HwidDevice[]; total: number } }>(
      this.opts,
      'GET',
      `/api/hwid/devices?start=${start}&size=${size}`,
    );
    return data.response;
  }

  async getHwidDeviceCount(user: UserRef): Promise<number | null> {
    try {
      const idOrUuid = this.ver.v === '3' ? String(user.id) : user.uuid;
      const data = await api<{ response: unknown }>(this.opts, 'GET', `/api/hwid/devices/${idOrUuid}`);
      const r = data.response as { total?: number; devices?: unknown[] } | unknown[];
      if (Array.isArray(r)) return r.length;
      if (typeof r?.total === 'number') return r.total;
      if (Array.isArray(r?.devices)) return r.devices.length;
      return null;
    } catch {
      return null;
    }
  }

  async getTorrentReports(): Promise<TorrentReport[]> {
    const data = await api<{
      response: {
        reports?: Array<{
          id: number;
          userId: number;
          node: { name: string };
          report: { actionReport: { ip: string } };
          createdAt: string;
        }>;
        // на случай, если массив лежит прямо в response
        [k: string]: unknown;
      };
    }>(this.opts, 'GET', '/api/node-plugins/torrent-blocker?start=0&size=200');
    const list = Array.isArray(data.response) ? data.response : (data.response.reports ?? []);
    return (list as Array<{ id: number; userId: number; node: { name: string }; report: { actionReport: { ip: string } }; createdAt: string }>).map(
      (r) => ({
        id: r.id,
        userId: r.userId,
        ip: r.report?.actionReport?.ip ?? '',
        nodeName: r.node?.name ?? '',
        createdAt: Date.parse(r.createdAt) || Date.now(),
      }),
    );
  }

  async fetchNodeSessions(nodeUuid: string): Promise<NodeSessions> {
    if (this.ver.v === '3') return this.fetchNodeSessionsV3(nodeUuid);
    try {
      return await this.fetchNodeSessionsV2(nodeUuid);
    } catch (err) {
      // панель 3.x: старой ручки ip-control нет — переключаемся и пробуем заново
      if (is404(err)) {
        this.ver.set('3');
        return this.fetchNodeSessionsV3(nodeUuid);
      }
      throw err;
    }
  }

  private async fetchNodeSessionsV2(nodeUuid: string): Promise<NodeSessions> {
    const jobId = await startJobWithRetry(this.opts, `/api/ip-control/fetch-users-ips/${nodeUuid}`);
    return this.pollSessions(nodeUuid, `/api/ip-control/fetch-users-ips/result/${jobId}`);
  }

  private async fetchNodeSessionsV3(nodeUuid: string): Promise<NodeSessions> {
    const jobId = await startJobWithRetry(this.opts, `/api/connections/by-node/${nodeUuid}`);
    return this.pollSessions(nodeUuid, `/api/connections/by-node/${jobId}`);
  }

  /**
   * Job выполняется на ноде и обычно готов за секунду: первые секунды спрашиваем часто,
   * дальше реже. Панель держит в работе ограниченное число таких job (5 в 2.7.x, 10 в 3.x),
   * остальные ждут в её очереди — потолок ожидания ~75 с покрывает и это.
   * Сбой ОДНОГО запроса за результатом (429, 5xx, обрыв, таймаут) ноду не списывает:
   * job в панели живёт, спрашиваем дальше до дедлайна. Списываем только по дедлайну или
   * когда сама панель говорит, что job провалился либо нода ей не ответила.
   */
  private async pollSessions(nodeUuid: string, resultPath: string): Promise<NodeSessions> {
    const POLL_SCHEDULE_MS = [500, 500, 750, 1000, 1500, 2000, 3000];
    const deadline = Date.now() + 75_000;
    let lastError: string | null = null;
    for (let attempt = 0; Date.now() < deadline; attempt++) {
      await sleep(POLL_SCHEDULE_MS[attempt] ?? 3000);
      let r: {
        isCompleted: boolean;
        isFailed: boolean;
        // userId: в 2.7.x строка, в 3.x число — нормализуем к строке
        result: { nodeUuid: string; success: boolean; users: Array<{ userId: number | string; ips: { ip: string; lastSeen: string }[] }> } | null;
      };
      try {
        r = (await api<{ response: typeof r }>(this.opts, 'GET', resultPath)).response;
      } catch (err) {
        if (!isTransient(err)) throw err;
        lastError = reasonOf(err);
        // панель просит подождать — ждём, сколько сказала (в пределах разумного)
        if (err instanceof ApiError && err.retryAfterMs > 0) await sleep(Math.min(err.retryAfterMs, 30_000));
        continue;
      }
      if (r.isFailed) return { nodeUuid, success: false, users: [], error: 'панель: job по ноде провалился' };
      if (r.isCompleted && r.result) {
        return {
          nodeUuid: r.result.nodeUuid,
          success: r.result.success,
          users: r.result.users.map((u) => ({ userId: String(u.userId), ips: u.ips })),
          ...(r.result.success
            ? {}
            : { error: 'нода не ответила панели (не подключена, недоступна или без NET_ADMIN)' }),
        };
      }
    }
    return {
      nodeUuid,
      success: false,
      users: [],
      error: lastError ? `результат не дождались за 75 с, последний сбой: ${lastError}` : 'результат не дождались за 75 с — очередь панели забита',
    };
  }
}

/** Карательные ручки. Единственное место в кодовой базе с пишущими вызовами к панели. */
export class HttpRemnaEnforcer implements RemnaEnforcer {
  constructor(
    private opts: HttpOpts,
    private ver: PanelVersionState = new PanelVersionState(),
  ) {}

  /** 2.7.x адресует юзера по uuid, 3.x — по числовому id; при 404 переключаем версию и повторяем */
  private async userAction(user: UserRef, action: 'disable' | 'enable' | 'revoke'): Promise<void> {
    const path = (idOrUuid: string) => `/api/users/${idOrUuid}/actions/${action}`;
    if (this.ver.v === '3') {
      await api(this.opts, 'POST', path(String(user.id)), {});
      return;
    }
    try {
      await api(this.opts, 'POST', path(user.uuid), {});
    } catch (err) {
      if (!is404(err)) throw err;
      this.ver.set('3');
      await api(this.opts, 'POST', path(String(user.id)), {});
    }
  }

  async disableUser(user: UserRef): Promise<void> {
    await this.userAction(user, 'disable');
  }

  async enableUser(user: UserRef): Promise<void> {
    await this.userAction(user, 'enable');
  }

  async revokeSubscription(user: UserRef): Promise<void> {
    await this.userAction(user, 'revoke');
  }

  private async drop(bodyV2: unknown, bodyV3: unknown): Promise<void> {
    if (this.ver.v === '3') {
      await api(this.opts, 'POST', '/api/connections/drop', bodyV3);
      return;
    }
    try {
      await api(this.opts, 'POST', '/api/ip-control/drop-connections', bodyV2);
    } catch (err) {
      if (!is404(err)) throw err;
      this.ver.set('3');
      await api(this.opts, 'POST', '/api/connections/drop', bodyV3);
    }
  }

  async dropConnectionsByIps(ips: string[]): Promise<void> {
    const dropBy = { by: 'ipAddresses', ipAddresses: ips };
    await this.drop(
      { dropBy, targetNodes: { target: 'allNodes' } },
      { dropBy, targetNodes: { target: 'allNodes' } },
    );
  }

  async dropConnectionsByUser(user: UserRef): Promise<void> {
    await this.drop(
      { dropBy: { by: 'userUuids', userUuids: [user.uuid] }, targetNodes: { target: 'allNodes' } },
      { dropBy: { by: 'userIds', userIds: [user.id] }, targetNodes: { target: 'allNodes' } },
    );
  }
}

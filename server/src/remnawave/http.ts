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

const is404 = (err: unknown): boolean => err instanceof Error && err.message.includes('HTTP 404');

interface HttpOpts {
  baseUrl: string;
  token: string;
  /** секрет nginx-защиты в формате key=value */
  secret?: string;
}

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
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Remnawave API ${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const pageSize = 500;
    const users: RemnaUser[] = [];
    for (let start = 0; ; start += pageSize) {
      const data = await api<{
        response: {
          total: number;
          users: Array<
            Omit<RemnaUser, 'usedTrafficBytes' | 'onlineAt' | 'expireAt' | 'uuid'> & {
              expireAt: string | null;
              userTraffic: { usedTrafficBytes: number; onlineAt: string | null };
              /** 2.7.x отдаёт uuid; в новых версиях панели его в списке нет — есть vlessUuid */
              uuid?: string;
              vlessUuid?: string;
            }
          >;
        };
      }>(this.opts, 'GET', `/api/users/?start=${start}&size=${pageSize}`);
      // детект версии панели: 2.7.x отдаёт uuid юзера в списке, 3.x — нет
      const first = data.response.users[0];
      if (first) this.ver.set(first.uuid !== undefined ? '2' : '3');
      for (const u of data.response.users) {
        users.push({
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
        });
      }
      if (users.length >= data.response.total || data.response.users.length === 0) break;
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
    const started = await api<{ response: { jobId: string } }>(
      this.opts,
      'POST',
      `/api/ip-control/fetch-users-ips/${nodeUuid}`,
    );
    return this.pollSessions(nodeUuid, `/api/ip-control/fetch-users-ips/result/${started.response.jobId}`);
  }

  private async fetchNodeSessionsV3(nodeUuid: string): Promise<NodeSessions> {
    const started = await api<{ response: { jobId: string } }>(
      this.opts,
      'POST',
      `/api/connections/by-node/${nodeUuid}`,
    );
    return this.pollSessions(nodeUuid, `/api/connections/by-node/${started.response.jobId}`);
  }

  /** Job выполняется на ноде; ждём результат с бэкоффом, максимум ~60 сек */
  private async pollSessions(nodeUuid: string, resultPath: string): Promise<NodeSessions> {
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(Math.min(500 + attempt * 250, 3000));
      const data = await api<{
        response: {
          isCompleted: boolean;
          isFailed: boolean;
          // userId: в 2.7.x строка, в 3.x число — нормализуем к строке
          result: { nodeUuid: string; success: boolean; users: Array<{ userId: number | string; ips: { ip: string; lastSeen: string }[] }> } | null;
        };
      }>(this.opts, 'GET', resultPath);
      const r = data.response;
      if (r.isFailed) return { nodeUuid, success: false, users: [] };
      if (r.isCompleted && r.result) {
        return {
          nodeUuid: r.result.nodeUuid,
          success: r.result.success,
          users: r.result.users.map((u) => ({ userId: String(u.userId), ips: u.ips })),
        };
      }
    }
    return { nodeUuid, success: false, users: [] };
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

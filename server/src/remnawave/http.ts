import type { HwidDevice, NodeSessions, RemnaEnforcer, RemnaNode, RemnaReader, RemnaUser, TorrentReport } from './types.js';

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
  constructor(private opts: HttpOpts) {}

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
            Omit<RemnaUser, 'usedTrafficBytes' | 'onlineAt' | 'expireAt'> & {
              expireAt: string | null;
              userTraffic: { usedTrafficBytes: number; onlineAt: string | null };
            }
          >;
        };
      }>(this.opts, 'GET', `/api/users/?start=${start}&size=${pageSize}`);
      for (const u of data.response.users) {
        users.push({
          id: u.id,
          uuid: u.uuid,
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

  async getHwidDeviceCount(userUuid: string): Promise<number | null> {
    try {
      const data = await api<{ response: unknown }>(this.opts, 'GET', `/api/hwid/devices/${userUuid}`);
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
    const started = await api<{ response: { jobId: string } }>(
      this.opts,
      'POST',
      `/api/ip-control/fetch-users-ips/${nodeUuid}`,
    );
    const jobId = started.response.jobId;

    // Job выполняется на ноде; ждём результат с бэкоффом, максимум ~60 сек
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(Math.min(500 + attempt * 250, 3000));
      const data = await api<{
        response: {
          isCompleted: boolean;
          isFailed: boolean;
          result: NodeSessions | null;
        };
      }>(this.opts, 'GET', `/api/ip-control/fetch-users-ips/result/${jobId}`);
      const r = data.response;
      if (r.isFailed) return { nodeUuid, success: false, users: [] };
      if (r.isCompleted && r.result) return r.result;
    }
    return { nodeUuid, success: false, users: [] };
  }
}

/** Карательные ручки. Единственное место в кодовой базе с пишущими вызовами к панели. */
export class HttpRemnaEnforcer implements RemnaEnforcer {
  constructor(private opts: HttpOpts) {}

  async disableUser(uuid: string): Promise<void> {
    await api(this.opts, 'POST', `/api/users/${uuid}/actions/disable`);
  }

  async enableUser(uuid: string): Promise<void> {
    await api(this.opts, 'POST', `/api/users/${uuid}/actions/enable`);
  }

  async revokeSubscription(uuid: string): Promise<void> {
    await api(this.opts, 'POST', `/api/users/${uuid}/actions/revoke`, {});
  }

  async dropConnectionsByIps(ips: string[]): Promise<void> {
    await api(this.opts, 'POST', '/api/ip-control/drop-connections', {
      dropBy: { by: 'ipAddresses', ipAddresses: ips },
      targetNodes: { target: 'allNodes' },
    });
  }

  async dropConnectionsByUser(uuid: string): Promise<void> {
    await api(this.opts, 'POST', '/api/ip-control/drop-connections', {
      dropBy: { by: 'userUuids', userUuids: [uuid] },
      targetNodes: { target: 'allNodes' },
    });
  }
}

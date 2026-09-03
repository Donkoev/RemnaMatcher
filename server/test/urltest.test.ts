import { describe, expect, it } from 'vitest';
import { serverOutbound } from '../src/red/urltest.js';
import type { SubServer } from '../src/red/subscriptions.js';

const base = (link: string): SubServer => ({
  protocol: 'X',
  name: 'n',
  flag: null,
  address: 'a',
  port: 1,
  transport: null,
  security: null,
  link,
});

describe('serverOutbound', () => {
  it('vless + reality → outbound с realitySettings и flow', () => {
    const o = serverOutbound(
      base('vless://uuid-1@1.2.3.4:443?type=tcp&security=reality&sni=example.com&pbk=PUB&sid=0123&fp=chrome&flow=xtls-rprx-vision#x'),
    ) as { protocol: string; settings: { vnext: { address: string; port: number; users: { id: string; flow?: string }[] }[] }; streamSettings: Record<string, unknown> };
    expect(o.protocol).toBe('vless');
    expect(o.settings.vnext[0]).toMatchObject({ address: '1.2.3.4', port: 443 });
    expect(o.settings.vnext[0]!.users[0]).toMatchObject({ id: 'uuid-1', flow: 'xtls-rprx-vision', encryption: 'none' });
    expect(o.streamSettings).toMatchObject({
      network: 'tcp',
      security: 'reality',
      realitySettings: { serverName: 'example.com', publicKey: 'PUB', shortId: '0123', fingerprint: 'chrome' },
    });
  });

  it('vmess ws+tls → outbound c wsSettings и tlsSettings', () => {
    const link = 'vmess://' + Buffer.from(JSON.stringify({ add: 'h.example', port: 443, id: 'ID', net: 'ws', tls: 'tls', host: 'cdn.example', path: '/p', sni: 'h.example' })).toString('base64');
    const o = serverOutbound(base(link)) as { protocol: string; streamSettings: Record<string, unknown> };
    expect(o.protocol).toBe('vmess');
    expect(o.streamSettings).toMatchObject({ network: 'ws', security: 'tls', wsSettings: { path: '/p', host: 'cdn.example' }, tlsSettings: { serverName: 'h.example' } });
  });

  it('ss SIP002 с plain и с base64 userinfo → shadowsocks outbound', () => {
    const plain = serverOutbound(base('ss://2022-blake3-aes-128-gcm:p%40ss@9.9.9.9:8388#x')) as { settings: { servers: Record<string, unknown>[] } };
    expect(plain.settings.servers[0]).toMatchObject({ address: '9.9.9.9', port: 8388, method: '2022-blake3-aes-128-gcm', password: 'p@ss' });
    const b64 = serverOutbound(base('ss://' + Buffer.from('aes-256-gcm:secret').toString('base64') + '@9.9.9.9:8388')) as { settings: { servers: Record<string, unknown>[] } };
    expect(b64.settings.servers[0]).toMatchObject({ method: 'aes-256-gcm', password: 'secret' });
  });

  it('готовый outbound из JSON-конфига отдаётся копией, мусорная ссылка → null', () => {
    const outbound = { protocol: 'trojan', settings: {} };
    const copy = serverOutbound({ ...base(''), link: undefined, outbound });
    expect(copy).toEqual(outbound);
    expect(copy).not.toBe(outbound);
    expect(serverOutbound(base('vless://@:0'))).toBeNull();
    expect(serverOutbound({ ...base(''), link: undefined })).toBeNull();
  });
});

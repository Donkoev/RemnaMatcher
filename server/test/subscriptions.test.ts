import { describe, expect, it } from 'vitest';
import { parseSubscriptionBody, parseUserinfo, tryBase64 } from '../src/red/subscriptions.js';

const VLESS = 'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?type=tcp&security=reality&sni=example.com&pbk=key&sid=ab#%F0%9F%87%A9%F0%9F%87%AA%20Germany-1';
const TROJAN = 'trojan://secret@host.example.net:8443?type=ws&path=%2Fws#Trojan%20NL';
const VMESS = 'vmess://' + Buffer.from(JSON.stringify({ v: '2', ps: '🇫🇷 Paris', add: '5.6.7.8', port: '2053', id: 'uuid', net: 'ws', tls: 'tls' })).toString('base64');
const SS = 'ss://' + Buffer.from('aes-256-gcm:pass@9.9.9.9:8388').toString('base64') + '#SS%20box';

describe('tryBase64', () => {
  it('декодирует обычный и url-safe base64', () => {
    expect(tryBase64(Buffer.from('hello world!').toString('base64'))).toBe('hello world!');
    expect(tryBase64(Buffer.from('hello world!').toString('base64url'))).toBe('hello world!');
  });

  it('возвращает null для не-base64 и для бинарного содержимого', () => {
    expect(tryBase64('vless://x@y:1')).toBeNull();
    expect(tryBase64('abc')).toBeNull();
    expect(tryBase64(Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x82]).toString('base64'))).toBeNull();
  });
});

describe('parseSubscriptionBody', () => {
  it('разбирает ссылки vless/trojan/vmess/ss, вытаскивает флаг из имени и сохраняет ссылку', () => {
    const list = parseSubscriptionBody([VLESS, TROJAN, VMESS, SS, '# comment', ''].join('\n'));
    expect(list.map((s) => s.protocol)).toEqual(['VLESS', 'TROJAN', 'VMESS', 'SS']);

    const v = list[0]!;
    expect(v).toMatchObject({ address: '1.2.3.4', port: 443, transport: 'tcp', security: 'reality', flag: '🇩🇪', name: 'Germany-1' });
    expect(v.link).toBe(VLESS);

    expect(list[1]).toMatchObject({ address: 'host.example.net', port: 8443, transport: 'ws', security: 'tls', flag: null });
    expect(list[2]).toMatchObject({ address: '5.6.7.8', port: 2053, transport: 'ws', security: 'tls', flag: '🇫🇷', name: 'Paris' });
    expect(list[3]).toMatchObject({ address: '9.9.9.9', port: 8388, name: 'SS box' });
  });

  it('понимает тело, целиком закодированное в base64', () => {
    const body = Buffer.from(`${VLESS}\n${SS}\n`).toString('base64');
    expect(parseSubscriptionBody(body).map((s) => s.protocol)).toEqual(['VLESS', 'SS']);
  });

  it('JSON-подписка: один прокси — строка, несколько — пул балансировщика', () => {
    const cfg = (remarks: string, addrs: string[]) => ({
      remarks,
      outbounds: [
        ...addrs.map((address, i) => ({
          protocol: 'vless',
          tag: `proxy-${i}`,
          settings: { vnext: [{ address, port: 443, users: [{ id: 'u' }] }] },
          streamSettings: { network: 'tcp', security: 'reality' },
        })),
        { protocol: 'freedom', tag: 'direct' },
      ],
    });
    const list = parseSubscriptionBody(JSON.stringify([cfg('🇳🇱 Single', ['1.1.1.1']), cfg('Balancer', ['2.2.2.2', '3.3.3.3'])]));
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ name: 'Single', flag: '🇳🇱', address: '1.1.1.1', fromJson: true });
    expect(list[0]!.pool).toBeUndefined();
    expect(list[1]).toMatchObject({ name: 'Balancer', protocol: 'VLESS', address: '' });
    expect(list[1]!.pool?.map((p) => p.address)).toEqual(['2.2.2.2', '3.3.3.3']);
  });

  it('мусор молча пропускается', () => {
    expect(parseSubscriptionBody('hello\nworld://x\n')).toEqual([]);
  });
});

describe('parseUserinfo', () => {
  it('складывает upload+download, total и expire в мс', () => {
    expect(parseUserinfo('upload=100; download=900; total=10000; expire=1700000000')).toEqual({
      used: 1000,
      total: 10000,
      expireAt: 1700000000000,
    });
  });

  it('без заголовка и без счётчиков — null', () => {
    expect(parseUserinfo(null)).toEqual({ used: null, total: null, expireAt: null });
    expect(parseUserinfo('total=0; expire=0')).toEqual({ used: null, total: 0, expireAt: null });
  });
});

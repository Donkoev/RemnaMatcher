import { describe, expect, it } from 'vitest';
import { isPrivateIp } from '../src/api/net.js';

describe('isPrivateIp — защита прокси иконок от SSRF', () => {
  it('ловит приватные, loopback, link-local, CGNAT и IPv4-mapped адреса', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', '::ffff:10.1.1.1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });

  it('пропускает публичные', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2001:db8::1', '::ffff:8.8.8.8']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

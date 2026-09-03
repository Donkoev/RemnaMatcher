import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/api/auth.js';

describe('пароль администратора', () => {
  it('хэш проверяется, а чужой пароль и битый хэш — нет', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('correct horse batter', hash)).toBe(false);
    expect(await verifyPassword('anything', 'plain$garbage')).toBe(false);
  });

  it('одинаковый пароль даёт разные хэши (соль)', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
  });
});

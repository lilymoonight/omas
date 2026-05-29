import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/server/auth/password.js';

// vitest runs under Node, so this exercises the `argon2` npm fallback path.
// The Bun.password path is covered by the end-to-end login smoke against the
// compiled binary.
describe('password hashing', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, 'correct horse')).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse');
    expect(await verifyPassword(hash, 'wrong horse')).toBe(false);
  });

  it('rejects too-short passwords', async () => {
    await expect(hashPassword('short')).rejects.toThrow();
  });

  it('returns false (not throw) on a malformed hash', async () => {
    expect(await verifyPassword('not-a-phc-string', 'whatever')).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserStore, usersPath, isValidUsername, toPublic } from '../src/server/auth/users.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-users-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('isValidUsername', () => {
  it('accepts letters/digits/._- and rejects others', () => {
    expect(isValidUsername('alice')).toBe(true);
    expect(isValidUsername('a.b_c-1')).toBe(true);
    expect(isValidUsername('bad name')).toBe(false);
    expect(isValidUsername('bad/name')).toBe(false);
    expect(isValidUsername('')).toBe(false);
  });
});

describe('UserStore', () => {
  it('adds, finds by id/username, and reports sole/count', () => {
    const s = new UserStore(dir);
    s.load();
    expect(s.count()).toBe(0);
    const a = s.add({ username: 'admin', passwordHash: 'h1', role: 'admin' });
    expect(s.count()).toBe(1);
    expect(s.sole()?.id).toBe(a.id);
    expect(s.byUsername('admin')?.id).toBe(a.id);
    expect(s.byId(a.id)?.username).toBe('admin');
    s.add({ username: 'bob', passwordHash: 'h2', role: 'user', osUser: 'bob' });
    expect(s.count()).toBe(2);
    expect(s.sole()).toBeUndefined(); // ambiguous once >1
  });

  it('rejects duplicate usernames and invalid names', () => {
    const s = new UserStore(dir);
    s.add({ username: 'admin', passwordHash: 'h', role: 'admin' });
    expect(() => s.add({ username: 'admin', passwordHash: 'h', role: 'user' })).toThrow(/already exists/);
    expect(() => s.add({ username: 'bad name', passwordHash: 'h', role: 'user' })).toThrow(/invalid username/);
  });

  it('persists to a 0600 users.json and reloads', () => {
    const s = new UserStore(dir);
    s.add({ username: 'admin', passwordHash: 'h', role: 'admin', osUser: 'deploy', managed: true });
    s.save();
    const file = usersPath(dir);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const s2 = new UserStore(dir);
    s2.load();
    const u = s2.byUsername('admin');
    expect(u?.osUser).toBe('deploy');
    expect(u?.managed).toBe(true);
  });

  it('removes by id', () => {
    const s = new UserStore(dir);
    const a = s.add({ username: 'a', passwordHash: 'h', role: 'user' });
    expect(s.remove(a.id)?.username).toBe('a');
    expect(s.remove(a.id)).toBeNull();
    expect(s.count()).toBe(0);
  });

  it('setPassword updates the hash', () => {
    const s = new UserStore(dir);
    const a = s.add({ username: 'a', passwordHash: 'old', role: 'user' });
    expect(s.setPassword(a.id, 'new')).toBe(true);
    expect(s.byId(a.id)?.passwordHash).toBe('new');
    expect(s.setPassword('nope', 'x')).toBe(false);
  });

  it('toPublic omits the password hash', () => {
    const s = new UserStore(dir);
    const a = s.add({ username: 'a', passwordHash: 'secret', role: 'admin', osUser: 'a' });
    const pub = toPublic(a);
    expect(pub).toEqual({ id: a.id, username: 'a', role: 'admin', osUser: 'a' });
    expect(JSON.stringify(pub)).not.toContain('secret');
  });
});

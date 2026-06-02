import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { opStat, opReaddir, opRead, opWriteText, opUpload } from '../src/server/pty/fs-worker.js';
import { wrapAsUser, fsStat, fsRead, fsWriteText, chownToUser } from '../src/server/pty/fs-priv.js';
import type { OsUserInfo } from '../src/server/pty/os-user.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-fspriv-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const deploy: OsUserInfo = { name: 'deploy', uid: 1001, gid: 1001, home: '/home/deploy', shell: '/bin/bash' };

describe('fs op functions (in-process)', () => {
  it('opStat reports file/dir/missing', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hi');
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(await opStat(path.join(dir, 'a.txt'))).toMatchObject({ exists: true, isFile: true, isDir: false, size: 2 });
    expect(await opStat(path.join(dir, 'sub'))).toMatchObject({ exists: true, isFile: false, isDir: true });
    expect(await opStat(path.join(dir, 'nope'))).toMatchObject({ exists: false });
  });

  it('opReaddir lists entries with kind', async () => {
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    fs.mkdirSync(path.join(dir, 'd'));
    const { entries } = await opReaddir(dir);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName['f']).toMatchObject({ isFile: true, isDir: false });
    expect(byName['d']).toMatchObject({ isFile: false, isDir: true });
  });

  it('opRead returns text and detects binary', async () => {
    fs.writeFileSync(path.join(dir, 't.txt'), 'hello');
    const t = await opRead(path.join(dir, 't.txt'));
    expect(t).toMatchObject({ binary: false, content: 'hello', size: 5 });
    fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([1, 2, 0, 3]));
    const b = await opRead(path.join(dir, 'b.bin'));
    expect(b.binary).toBe(true);
  });

  it('opWriteText writes atomically', async () => {
    const target = path.join(dir, 'out.txt');
    const r = await opWriteText(target, 'data');
    expect(r.size).toBe(4);
    expect(fs.readFileSync(target, 'utf8')).toBe('data');
  });

  it('opUpload picks a collision-free name', async () => {
    fs.writeFileSync(path.join(dir, 'x.txt'), 'orig');
    const r = await opUpload(dir, 'x.txt', Buffer.from('new'));
    expect(path.basename(r.finalAbs)).toBe('x (1).txt');
    expect(fs.readFileSync(r.finalAbs, 'utf8')).toBe('new');
  });
});

describe('wrapAsUser', () => {
  it('passes through with no osUser', () => {
    const w = wrapAsUser(null, 'git', ['status']);
    expect(w.file).toBe('git');
    expect(w.args).toEqual(['status']);
    expect(w.env).toBe(process.env);
  });
  it('wraps with runuser and sets identity env on linux', () => {
    const orig = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const w = wrapAsUser(deploy, 'git', ['status']);
      expect(w.file).toBe('runuser');
      expect(w.args).toEqual(['-u', 'deploy', '--', 'git', 'status']);
      expect(w.env.HOME).toBe('/home/deploy');
      expect(w.env.USER).toBe('deploy');
    } finally {
      Object.defineProperty(process, 'platform', { value: orig });
    }
  });
});

describe('fs-priv delegation (osUser=null → in-process)', () => {
  it('fsStat/fsRead/fsWriteText hit the op functions', async () => {
    const f = path.join(dir, 'd.txt');
    await fsWriteText(null, f, 'abc');
    expect((await fsStat(null, f)).size).toBe(3);
    expect((await fsRead(null, f)).content).toBe('abc');
  });
  it('chownToUser is a no-op without osUser', async () => {
    const f = path.join(dir, 'c.txt');
    fs.writeFileSync(f, 'x');
    await expect(chownToUser(null, f)).resolves.toBeUndefined();
  });
});

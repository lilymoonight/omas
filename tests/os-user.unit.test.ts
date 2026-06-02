import { describe, it, expect } from 'vitest';
import { buildPrivilegeDrop, resolveOsUser, serverIsRoot, type OsUserInfo } from '../src/server/pty/os-user.js';

const info: OsUserInfo = { name: 'deploy', uid: 1001, gid: 1001, home: '/home/deploy', shell: '/bin/bash' };

describe('buildPrivilegeDrop', () => {
  it('wraps with runuser on linux', () => {
    const { file, args } = buildPrivilegeDrop('linux', info, '/bin/zsh', ['-l']);
    expect(file).toBe('runuser');
    expect(args).toEqual(['-u', 'deploy', '--', '/bin/zsh', '-l']);
  });
  it('wraps with sudo -H on darwin', () => {
    const { file, args } = buildPrivilegeDrop('darwin', info, '/bin/zsh', []);
    expect(file).toBe('sudo');
    expect(args).toEqual(['-H', '-u', 'deploy', '--', '/bin/zsh']);
  });
  it('throws on unsupported platforms', () => {
    expect(() => buildPrivilegeDrop('win32', info, 'cmd', [])).toThrow(/unsupported/);
  });
});

describe('serverIsRoot', () => {
  it('returns a boolean matching the process uid', () => {
    const expected = typeof process.getuid === 'function' && process.getuid() === 0;
    expect(serverIsRoot()).toBe(expected);
  });
});

describe('resolveOsUser', () => {
  it('rejects invalid usernames before shelling out', async () => {
    await expect(resolveOsUser('bad name')).rejects.toThrow(/invalid os user name/);
    await expect(resolveOsUser('../etc')).rejects.toThrow(/invalid os user name/);
  });
});

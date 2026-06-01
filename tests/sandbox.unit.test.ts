import { describe, it, expect } from 'vitest';
import { resolveSandboxDir, buildBwrapArgv, buildSeatbeltProfile, buildSandboxCommand } from '../src/server/pty/sandbox.js';

describe('resolveSandboxDir', () => {
  const root = '/srv/agent';

  it('defaults to the root itself when no cwd requested', () => {
    const r = resolveSandboxDir(root, undefined);
    expect(r).toEqual({ writable: '/srv/agent', home: '/srv/agent/.home', tmp: '/srv/agent/.tmp', cwd: '/srv/agent' });
  });

  it('treats a relative request as relative to the root', () => {
    const r = resolveSandboxDir(root, 'proj');
    expect(r?.writable).toBe('/srv/agent/proj');
    expect(r?.home).toBe('/srv/agent/proj/.home');
    expect(r?.tmp).toBe('/srv/agent/proj/.tmp');
  });

  it('accepts an absolute request inside the root', () => {
    expect(resolveSandboxDir(root, '/srv/agent/a/b')?.writable).toBe('/srv/agent/a/b');
  });

  it('rejects the whole-disk root', () => {
    expect(resolveSandboxDir(root, '/')).toBeNull();
  });

  it('rejects an absolute path outside the root', () => {
    expect(resolveSandboxDir(root, '/etc')).toBeNull();
  });

  it('rejects traversal escapes', () => {
    expect(resolveSandboxDir(root, '../../etc')).toBeNull();
    expect(resolveSandboxDir(root, 'proj/../../escape')).toBeNull();
  });

  it('rejects a sibling that merely shares the prefix string', () => {
    // /srv/agent-evil must not be considered inside /srv/agent
    expect(resolveSandboxDir(root, '/srv/agent-evil')).toBeNull();
  });
});

describe('buildBwrapArgv', () => {
  const base = { writable: '/srv/agent/proj', home: '/srv/agent/proj/.home', shell: '/bin/bash' };

  it('binds the whole FS read-only and the writable dir read-write', () => {
    const a = buildBwrapArgv({ ...base, net: true });
    const joined = a.join(' ');
    expect(joined).toContain('--ro-bind / /');
    expect(joined).toContain('--bind /srv/agent/proj /srv/agent/proj');
    // the rw bind must come AFTER the ro-bind so it wins
    expect(a.indexOf('--bind')).toBeGreaterThan(a.indexOf('--ro-bind'));
  });

  it('sets HOME, chdir and a tmpfs /tmp', () => {
    const a = buildBwrapArgv({ ...base, net: true });
    expect(a.join(' ')).toContain('--setenv HOME /srv/agent/proj/.home');
    expect(a.join(' ')).toContain('--chdir /srv/agent/proj');
    expect(a.join(' ')).toContain('--tmpfs /tmp');
    expect(a.join(' ')).toContain('--die-with-parent');
  });

  it('isolates the network only when net=false', () => {
    expect(buildBwrapArgv({ ...base, net: true }).join(' ')).not.toContain('--unshare-net');
    expect(buildBwrapArgv({ ...base, net: false }).join(' ')).toContain('--unshare-net');
  });

  it('ends with the shell after the -- separator', () => {
    const a = buildBwrapArgv({ ...base, net: true, shellArgs: ['-l'] });
    const sep = a.indexOf('--');
    expect(a.slice(sep)).toEqual(['--', '/bin/bash', '-l']);
  });

  it('exposes extra device nodes when requested', () => {
    const a = buildBwrapArgv({ ...base, net: true, devBinds: ['/dev/nvidia0'] });
    expect(a.join(' ')).toContain('--dev-bind /dev/nvidia0 /dev/nvidia0');
  });

  it('adds --new-session only when opted in', () => {
    expect(buildBwrapArgv({ ...base, net: true }).join(' ')).not.toContain('--new-session');
    expect(buildBwrapArgv({ ...base, net: true, newSession: true }).join(' ')).toContain('--new-session');
  });
});

describe('buildSeatbeltProfile (macOS)', () => {
  it('denies by default and only allows writes under the writable dir + /dev', () => {
    const p = buildSeatbeltProfile({ writable: '/private/srv/agent/proj', net: true });
    expect(p).toContain('(deny default)');
    expect(p).toContain('(allow file-read*)');
    // Terminal ioctls must be allowed or interactive shells break (ZLE/job control).
    expect(p).toContain('(allow file-ioctl)');
    expect(p).toContain('(allow file-write* (subpath "/private/srv/agent/proj"))');
    expect(p).toContain('(allow file-write* (subpath "/dev"))');
    // It must NOT broadly allow writes to /tmp or the per-user temp dir.
    expect(p).not.toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(p).not.toContain('(allow file-write* (subpath "/private/var/folders"))');
  });

  it('allows network only when net=true', () => {
    expect(buildSeatbeltProfile({ writable: '/w', net: true })).toContain('(allow network*)');
    expect(buildSeatbeltProfile({ writable: '/w', net: false })).not.toContain('(allow network*)');
  });

  it('escapes quotes/backslashes in the path', () => {
    const p = buildSeatbeltProfile({ writable: '/w/a"b\\c', net: false });
    expect(p).toContain('(allow file-write* (subpath "/w/a\\"b\\\\c"))');
  });
});

describe('buildSandboxCommand (platform dispatch)', () => {
  const opts = { writable: '/w/proj', home: '/w/proj/.home', tmp: '/w/proj/.tmp', net: true, shell: '/bin/bash' };

  it('uses bwrap on linux with HOME env', () => {
    const c = buildSandboxCommand('linux', opts);
    expect(c.file).toBe('bwrap');
    expect(c.args.join(' ')).toContain('--bind /w/proj /w/proj');
    expect(c.env).toEqual({ HOME: '/w/proj/.home' });
  });

  it('uses sandbox-exec on darwin with HOME+TMPDIR inside the writable dir', () => {
    const c = buildSandboxCommand('darwin', opts);
    expect(c.file).toBe('sandbox-exec');
    expect(c.args[0]).toBe('-p');
    expect(c.args[1]).toContain('(allow file-write* (subpath "/w/proj"))');
    // shell follows the profile
    expect(c.args.slice(2)).toEqual(['/bin/bash']);
    expect(c.env).toEqual({ HOME: '/w/proj/.home', TMPDIR: '/w/proj/.tmp' });
  });

  it('passes shellArgs through (e.g. exec sh -c)', () => {
    const c = buildSandboxCommand('darwin', { ...opts, shell: '/bin/sh', shellArgs: ['-c', 'echo hi'] });
    expect(c.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });
});

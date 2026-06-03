import { describe, it, expect } from 'vitest';
import { resolveSandboxDir, buildBwrapArgv, buildSeatbeltProfile, buildSandboxCommand, sandboxUnprivIds } from '../src/server/pty/sandbox.js';

describe('resolveSandboxDir', () => {
  const root = '/srv/agent';

  it('defaults to the root itself when no cwd requested', () => {
    const r = resolveSandboxDir(root, undefined);
    expect(r).toEqual({ writable: '/srv/agent', tmp: '/srv/agent/.tmp', cwd: '/srv/agent' });
  });

  it('treats a relative request as relative to the root', () => {
    const r = resolveSandboxDir(root, 'proj');
    expect(r?.writable).toBe('/srv/agent/proj');
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
  const base = { writable: '/srv/agent/proj', home: '/home/dev', shell: '/bin/bash' };

  it('binds the whole FS read-only and the writable dir + home read-write', () => {
    const a = buildBwrapArgv({ ...base, net: true });
    const joined = a.join(' ');
    expect(joined).toContain('--ro-bind / /');
    expect(joined).toContain('--bind /srv/agent/proj /srv/agent/proj');
    // The real home is bound read-write so agents can use their config/creds.
    expect(joined).toContain('--bind /home/dev /home/dev');
    // the rw bind must come AFTER the ro-bind so it wins
    expect(a.indexOf('--bind')).toBeGreaterThan(a.indexOf('--ro-bind'));
  });

  it('sets HOME to the real home, chdir to the working dir, and a tmpfs /tmp', () => {
    const a = buildBwrapArgv({ ...base, net: true });
    expect(a.join(' ')).toContain('--setenv HOME /home/dev');
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

  it('remaps to a non-root uid/gid (own user namespace) only when requested', () => {
    expect(buildBwrapArgv({ ...base, net: true }).join(' ')).not.toContain('--unshare-user');
    const a = buildBwrapArgv({ ...base, net: true, unprivUid: 1000, unprivGid: 1000 });
    const joined = a.join(' ');
    expect(joined).toContain('--unshare-user');
    expect(joined).toContain('--uid 1000');
    expect(joined).toContain('--gid 1000');
    // The remap flags must precede the `--` shell separator.
    expect(a.indexOf('--uid')).toBeLessThan(a.indexOf('--'));
  });
});

describe('sandboxUnprivIds', () => {
  it('returns null on non-linux platforms', () => {
    expect(sandboxUnprivIds('darwin')).toBeNull();
  });

  it('returns null on linux when the server is not root', () => {
    const realGetuid = process.getuid;
    try {
      (process as any).getuid = () => 1000;
      expect(sandboxUnprivIds('linux')).toBeNull();
    } finally {
      (process as any).getuid = realGetuid;
    }
  });

  it('prefers SUDO_UID/GID, falling back to 1000, when linux + root', () => {
    const realGetuid = process.getuid;
    const { SUDO_UID, SUDO_GID } = process.env;
    try {
      (process as any).getuid = () => 0;
      process.env.SUDO_UID = '1234';
      process.env.SUDO_GID = '5678';
      expect(sandboxUnprivIds('linux')).toEqual({ uid: 1234, gid: 5678 });

      delete process.env.SUDO_UID;
      delete process.env.SUDO_GID;
      expect(sandboxUnprivIds('linux')).toEqual({ uid: 1000, gid: 1000 });
    } finally {
      (process as any).getuid = realGetuid;
      if (SUDO_UID === undefined) delete process.env.SUDO_UID; else process.env.SUDO_UID = SUDO_UID;
      if (SUDO_GID === undefined) delete process.env.SUDO_GID; else process.env.SUDO_GID = SUDO_GID;
    }
  });
});

describe('buildSeatbeltProfile (macOS)', () => {
  it('denies by default and allows writes under the writable dir + home + /dev', () => {
    const p = buildSeatbeltProfile({ writable: '/private/srv/agent/proj', home: '/Users/dev', net: true });
    expect(p).toContain('(deny default)');
    expect(p).toContain('(allow file-read*)');
    // Terminal ioctls must be allowed or interactive shells break (ZLE/job control).
    expect(p).toContain('(allow file-ioctl)');
    // Scheduling priority must be allowed or zsh's BG_NICE prints nice() errors.
    expect(p).toContain('(allow system-sched)');
    expect(p).toContain('(allow file-write* (subpath "/private/srv/agent/proj"))');
    // The real home is writable so agents can persist config/credentials/state.
    expect(p).toContain('(allow file-write* (subpath "/Users/dev"))');
    expect(p).toContain('(allow file-write* (subpath "/dev"))');
    // System temp dirs are writable (mirrors Linux's tmpfs /tmp) so tools that
    // hardcode /tmp — Claude Code's snapshots / Bash tool, etc. — aren't denied.
    expect(p).toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(p).toContain('(allow file-write* (subpath "/private/var/folders"))');
    expect(p).toContain('(allow file-write* (subpath "/private/var/tmp"))');
  });

  it('allows network only when net=true', () => {
    expect(buildSeatbeltProfile({ writable: '/w', home: '/Users/dev', net: true })).toContain('(allow network*)');
    expect(buildSeatbeltProfile({ writable: '/w', home: '/Users/dev', net: false })).not.toContain('(allow network*)');
  });

  it('escapes quotes/backslashes in the path', () => {
    const p = buildSeatbeltProfile({ writable: '/w/a"b\\c', home: '/Users/dev', net: false });
    expect(p).toContain('(allow file-write* (subpath "/w/a\\"b\\\\c"))');
  });
});

describe('buildSandboxCommand (platform dispatch)', () => {
  const opts = { writable: '/w/proj', home: '/Users/dev', tmp: '/w/proj/.tmp', net: true, shell: '/bin/bash' };

  it('uses bwrap on linux with HOME env and a writable home bind', () => {
    const c = buildSandboxCommand('linux', opts);
    expect(c.file).toBe('bwrap');
    expect(c.args.join(' ')).toContain('--bind /w/proj /w/proj');
    expect(c.args.join(' ')).toContain('--bind /Users/dev /Users/dev');
    expect(c.env).toEqual({ HOME: '/Users/dev' });
  });

  it('uses sandbox-exec on darwin with real HOME (writable) + TMPDIR in the working dir', () => {
    const c = buildSandboxCommand('darwin', opts);
    expect(c.file).toBe('sandbox-exec');
    expect(c.args[0]).toBe('-p');
    expect(c.args[1]).toContain('(allow file-write* (subpath "/w/proj"))');
    expect(c.args[1]).toContain('(allow file-write* (subpath "/Users/dev"))');
    // shell follows the profile
    expect(c.args.slice(2)).toEqual(['/bin/bash']);
    expect(c.env).toEqual({ HOME: '/Users/dev', TMPDIR: '/w/proj/.tmp' });
  });

  it('passes shellArgs through (e.g. exec sh -c)', () => {
    const c = buildSandboxCommand('darwin', { ...opts, shell: '/bin/sh', shellArgs: ['-c', 'echo hi'] });
    expect(c.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });
});

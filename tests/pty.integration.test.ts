import { describe, it, expect } from 'vitest';
import { PtySession } from '../src/server/pty/session.js';
import { SessionHub } from '../src/server/pty/hub.js';

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isDarwinBun =
  process.platform === 'darwin' && typeof (process.versions as { bun?: string }).bun === 'string';

async function waitFor<T>(pred: () => T | undefined, timeoutMs = 3000, intervalMs = 20): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = pred();
    if (v) return v;
    await settle(intervalMs);
  }
  throw new Error('waitFor timed out');
}

describe('PtySession (spawns real shell)', () => {
  it('echoes input back through the PTY and records to ring', async () => {
    const s = new PtySession({ shell: '/bin/bash', cols: 80, rows: 24, scrollbackBytes: 64 * 1024 });
    try {
      // Disable PS1 noise so output is predictable.
      s.write('PS1= ; export PS1\n');
      s.write('echo hi-from-test-7f3b\n');
      await waitFor(() => {
        const dump = s.ring.since(0).bytes.toString();
        return dump.includes('hi-from-test-7f3b') ? true : undefined;
      });
      expect(s.ring.since(0).bytes.toString()).toContain('hi-from-test-7f3b');
    } finally {
      s.kill('SIGKILL');
      await waitFor(() => (s.exited ? true : undefined));
    }
  });

  it('reports exit when shell exits cleanly', async () => {
    const s = new PtySession({ shell: '/bin/bash', cols: 80, rows: 24, scrollbackBytes: 4096 });
    // Some PTY+bash combinations under vitest don't emit the first prompt until
    // input arrives, so just send the exit command right away.
    s.write('exit 0\n');
    await waitFor(() => (s.exited ? true : undefined), 8000);
    expect(s.exited).toBe(true);
  });

  it.skipIf(!isDarwinBun)('starts in requested cwd on macOS Bun PTY', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const target = await mkdtemp('/tmp/omas-cwd-');
    const s = new PtySession({
      shell: '/bin/zsh',
      cwd: target,
      cols: 80,
      rows: 24,
      scrollbackBytes: 64 * 1024,
    });
    try {
      s.write('PS1= ; export PS1\n');
      s.write('pwd\n');
      await waitFor(() => {
        const dump = s.ring.since(0).bytes.toString();
        return dump.includes(target) ? true : undefined;
      }, 5000);
      expect(s.ring.since(0).bytes.toString()).toContain(target);
    } finally {
      s.kill('SIGKILL');
      await waitFor(() => (s.exited ? true : undefined));
    }
  });

  it('serializeSnapshot reports current dimensions', () => {
    const s = new PtySession({ shell: '/bin/bash', cols: 100, rows: 30, scrollbackBytes: 4096 });
    const snap = s.serializeSnapshot();
    expect(snap.cols).toBe(100);
    expect(snap.rows).toBe(30);
    s.kill('SIGKILL');
  });

  it('serializeSnapshot includes live screen output', async () => {
    const s = new PtySession({ shell: '/bin/bash', cols: 80, rows: 24, scrollbackBytes: 64 * 1024 });
    try {
      s.write('PS1= ; export PS1\n');
      s.write('echo snap-marker-9c2e\n');
      // Poll the cheap ring buffer for the marker first; rebuilding a headless
      // terminal via serializeSnapshot() on every tick is expensive and can
      // starve the event loop on slow CI runners, causing spurious timeouts.
      await waitFor(
        () => (s.ring.since(0).bytes.toString().includes('snap-marker-9c2e') ? true : undefined),
        8000,
      );
      const snap = s.serializeSnapshot();
      expect(snap.bytes.length).toBeGreaterThan(0);
      expect(snap.bytes.toString()).toContain('snap-marker-9c2e');
    } finally {
      s.kill('SIGKILL');
      await waitFor(() => (s.exited ? true : undefined));
    }
  });

  it('Ctrl+C is delivered to the foreground process group', async () => {
    const s = new PtySession({ shell: '/bin/bash', cols: 80, rows: 24, scrollbackBytes: 8192 });
    try {
      s.write('PS1= ; export PS1\n');
      s.write('sleep 30\n');
      await settle(200);
      // Send SIGINT via the PTY (Ctrl+C). The kernel's line discipline should turn
      // 0x03 into SIGINT for the foreground pgid, killing sleep but not the shell.
      s.write('\x03');
      // After the SIGINT, the shell prints a new prompt — but we just want the sleep
      // to be gone. Send an `echo` and make sure it executes quickly.
      s.write('echo post-sigint-marker\n');
      await waitFor(() => (s.ring.since(0).bytes.toString().includes('post-sigint-marker') ? true : undefined));
      expect(s.exited).toBe(false);
    } finally {
      s.kill('SIGKILL');
      await waitFor(() => (s.exited ? true : undefined));
    }
  });
});

describe('SessionHub', () => {
  it('CRUD: create, list, get, destroy', async () => {
    const hub = new SessionHub({ maxSessions: 4, scrollbackBytes: 8192 });
    try {
      const a = hub.create({ shell: '/bin/bash', cols: 80, rows: 24 });
      const b = hub.create({ shell: '/bin/bash', cols: 80, rows: 24 });
      expect(hub.list().length).toBe(2);
      expect(hub.get(a.id)).toBe(a);
      expect(hub.get(b.id)).toBe(b);
      expect(hub.destroy(a.id)).toBe(true);
      // PTY exit propagates async; the destroy itself already removed from the map
      expect(hub.get(a.id)).toBeUndefined();
    } finally {
      await hub.shutdownAll();
    }
  });

  it('enforces maxSessions with 429', () => {
    const hub = new SessionHub({ maxSessions: 1, scrollbackBytes: 4096 });
    try {
      hub.create({ shell: '/bin/bash', cols: 80, rows: 24 });
      expect(() => hub.create({ shell: '/bin/bash', cols: 80, rows: 24 })).toThrowError(/max/);
    } finally {
      void hub.shutdownAll();
    }
  });
});

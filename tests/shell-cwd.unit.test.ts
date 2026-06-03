import { describe, it, expect } from 'vitest';
import { parsePsRows } from '../src/server/pty/foreground.js';
import { cwdTargetPid, findShellPid } from '../src/server/pty/shell-cwd.js';
import { buildProcIndex } from '../src/server/pty/foreground.js';

describe('cwdTargetPid', () => {
  it('uses the interactive shell when the wrapper cwd would stay at spawn dir', () => {
    const idle = parsePsRows(
      [
        ' 100   1 Ss   0:00 bwrap --bind /srv/agent /srv/agent -- zsh',
        ' 200 100 Ss+  0:01 /bin/zsh',
      ].join('\n'),
    );
    const ix = buildProcIndex(idle);
    expect(findShellPid(idle, 100, '/bin/zsh', ix)).toBe(200);
    expect(cwdTargetPid(idle, 100, '/bin/zsh', ix)).toBe(200);
  });

  it('prefers the foreground app cwd when an agent is running', () => {
    const fg = parsePsRows(
      [
        ' 100   1 Ss   0:00 bwrap -- zsh',
        ' 200 100 S+   0:01 /bin/zsh',
        ' 300 200 S+   0:05 claude --resume abc',
      ].join('\n'),
    );
    const ix = buildProcIndex(fg);
    expect(cwdTargetPid(fg, 100, '/bin/zsh', ix)).toBe(300);
  });

  it('falls back to the PTY root when no shell child is found', () => {
    const solo = parsePsRows(' 100   1 Ss+  0:00 /bin/zsh');
    const ix = buildProcIndex(solo);
    expect(cwdTargetPid(solo, 100, '/bin/zsh', ix)).toBe(100);
  });
});

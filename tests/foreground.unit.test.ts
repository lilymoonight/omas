import { describe, it, expect } from 'vitest';
import {
  classifyAgent,
  commandBasename,
  parseCpuSeconds,
  parsePsRows,
  resolveForeground,
  subtreePids,
  subtreeCpuRate,
  ACTIVE_CPU_RATE,
} from '../src/server/pty/foreground.js';

describe('parseCpuSeconds', () => {
  it('parses BSD/Linux TIME formats into seconds', () => {
    expect(parseCpuSeconds('0:03')).toBe(3);
    expect(parseCpuSeconds('1:02')).toBe(62);
    expect(parseCpuSeconds('0:03.50')).toBeCloseTo(3.5);
    expect(parseCpuSeconds('1:02:03')).toBe(3723);
    expect(parseCpuSeconds('1-02:03:04')).toBe(93784);
    expect(parseCpuSeconds('')).toBe(0);
  });
});

describe('subtreePids', () => {
  it('collects the root and all descendants', () => {
    const rows = parsePsRows(
      [
        ' 100 1   Ss 0:00 /bin/zsh',
        ' 200 100 S+ 0:01 node agent',
        ' 300 200 R+ 0:05 child-tool',
        ' 400 300 R+ 0:02 grandchild',
        ' 999 1   Ss 0:00 unrelated',
      ].join('\n'),
    );
    expect(subtreePids(rows, 200).sort((a, b) => a - b)).toEqual([200, 300, 400]);
  });
});

describe('subtreeCpuRate', () => {
  const rows = parsePsRows(
    [
      ' 200 100 S+ 0:00 node agent',
      ' 300 200 R+ 0:00 child',
    ].join('\n'),
  );
  it('returns the per-core CPU rate across snapshots', () => {
    const prev = { at: 0, byPid: new Map([[200, 1], [300, 1]]) };
    const cur = { at: 2000, byPid: new Map([[200, 1.5], [300, 1.7]]) }; // +1.2s CPU over 2s wall
    expect(subtreeCpuRate(rows, 200, prev, cur)).toBeCloseTo(0.6);
  });
  it('is ~0 when cputime barely advances (idle agent)', () => {
    const prev = { at: 0, byPid: new Map([[200, 5], [300, 5]]) };
    const cur = { at: 3000, byPid: new Map([[200, 5.001], [300, 5]]) };
    const rate = subtreeCpuRate(rows, 200, prev, cur);
    expect(rate).toBeLessThan(ACTIVE_CPU_RATE);
  });
  it('returns 0 for a non-positive window', () => {
    const prev = { at: 1000, byPid: new Map([[200, 1]]) };
    const cur = { at: 1000, byPid: new Map([[200, 9]]) };
    expect(subtreeCpuRate(rows, 200, prev, cur)).toBe(0);
  });
});

describe('classifyAgent', () => {
  it('recognizes claude', () => {
    expect(classifyAgent('claude --resume abc')).toBe('claude');
    expect(classifyAgent('node /usr/local/lib/node_modules/@anthropic/claude/cli.js')).toBe('claude');
  });

  it('recognizes cursor-agent (not bare cursor editor)', () => {
    expect(classifyAgent('cursor-agent --resume xyz')).toBe('cursor');
    expect(classifyAgent('node /opt/cursor-agent/bin.js')).toBe('cursor');
  });

  it('recognizes qoder (qodercli binary or informal name)', () => {
    expect(classifyAgent('qodercli -r 123')).toBe('qoder');
    expect(classifyAgent('qoder chat')).toBe('qoder');
  });

  it('returns null for plain programs', () => {
    expect(classifyAgent('vim file.txt')).toBeNull();
    expect(classifyAgent('/bin/zsh')).toBeNull();
    expect(classifyAgent('node server.js')).toBeNull();
  });
});

describe('commandBasename', () => {
  it('takes the basename of argv0', () => {
    expect(commandBasename('/usr/bin/vim file.txt')).toBe('vim');
    expect(commandBasename('top')).toBe('top');
    expect(commandBasename('/opt/homebrew/bin/htop -d 5')).toBe('htop');
  });
});

describe('parsePsRows', () => {
  it('parses pid/ppid/stat/time/command rows', () => {
    const out = parsePsRows(
      [
        ' 100   1 Ss   0:00 /bin/zsh',
        ' 200 100 S+   0:12 node /x/claude/cli.js --resume a',
        'garbage line',
        ' 300 200 R+   1:05 node worker',
      ].join('\n'),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ pid: 100, ppid: 1, stat: 'Ss', cpuTime: 0, command: '/bin/zsh' });
    expect(out[1]!.cpuTime).toBe(12);
    expect(out[1]!.command).toContain('claude');
    expect(out[2]!.cpuTime).toBe(65);
  });
});

describe('resolveForeground', () => {
  const SHELL = 100;

  it('idle shell at prompt → null', () => {
    const rows = parsePsRows(' 100 1 Ss+ 0:00 /bin/zsh');
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: null, agent: null });
  });

  it('detects a foreground agent descendant', () => {
    const rows = parsePsRows(
      [
        ' 100   1 Ss  0:00 /bin/zsh',
        ' 200 100 S+  0:12 node /x/claude/cli.js --resume a',
      ].join('\n'),
    );
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: 'claude', agent: 'claude' });
  });

  it('prefers the recognized agent over a generic foreground child', () => {
    const rows = parsePsRows(
      [
        ' 100   1 Ss  0:00 /bin/zsh',
        ' 200 100 S+  0:12 cursor-agent --resume z',
        ' 300 200 R+  0:01 node worker',
      ].join('\n'),
    );
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: 'cursor', agent: 'cursor' });
  });

  it('reports a non-agent foreground program by basename', () => {
    const rows = parsePsRows(
      [
        ' 100   1 Ss  0:00 /bin/zsh',
        ' 200 100 S+  0:03 /usr/bin/vim notes.md',
      ].join('\n'),
    );
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: 'vim', agent: null });
  });
});

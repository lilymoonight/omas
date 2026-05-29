import { describe, it, expect } from 'vitest';
import {
  classifyAgent,
  commandBasename,
  parsePsRows,
  resolveForeground,
} from '../src/server/pty/foreground.js';

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
  it('parses pid/ppid/stat/command rows', () => {
    const out = parsePsRows(
      [
        ' 100   1 Ss   /bin/zsh',
        ' 200 100 S+   node /x/claude/cli.js --resume a',
        'garbage line',
        ' 300 200 R+   node worker',
      ].join('\n'),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ pid: 100, ppid: 1, stat: 'Ss', command: '/bin/zsh' });
    expect(out[1]!.command).toContain('claude');
  });
});

describe('resolveForeground', () => {
  const SHELL = 100;

  it('idle shell at prompt → null', () => {
    const rows = parsePsRows(' 100 1 Ss+ /bin/zsh');
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: null, agent: null });
  });

  it('detects a foreground agent descendant', () => {
    const rows = parsePsRows(
      [
        ' 100   1 Ss  /bin/zsh',
        ' 200 100 S+  node /x/claude/cli.js --resume a',
      ].join('\n'),
    );
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: 'claude', agent: 'claude' });
  });

  it('prefers the recognized agent over a generic foreground child', () => {
    const rows = parsePsRows(
      [
        ' 100   1 Ss  /bin/zsh',
        ' 200 100 S+  cursor-agent --resume z',
        ' 300 200 R+  node worker',
      ].join('\n'),
    );
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: 'cursor', agent: 'cursor' });
  });

  it('reports a non-agent foreground program by basename', () => {
    const rows = parsePsRows(
      [
        ' 100   1 Ss  /bin/zsh',
        ' 200 100 S+  /usr/bin/vim notes.md',
      ].join('\n'),
    );
    expect(resolveForeground(rows, SHELL)).toEqual({ foreground: 'vim', agent: null });
  });
});

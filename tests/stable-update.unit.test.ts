import { describe, it, expect } from 'vitest';
import {
  fsEntriesEqual,
  historySessionsEqual,
  gitStatusEqual,
} from '../src/web/lib/stable-update.js';
import type { HistorySession } from '../src/web/lib/api.js';

describe('stable-update', () => {
  it('fsEntriesEqual detects changes', () => {
    const a = [{ name: 'a', path: 'a', kind: 'file' as const }];
    expect(fsEntriesEqual(a, a)).toBe(true);
    expect(fsEntriesEqual(a, [{ name: 'b', path: 'b', kind: 'file' }])).toBe(false);
  });

  it('historySessionsEqual is order-insensitive', () => {
    const s = (id: string): HistorySession => ({
      source: 'claude-code',
      id,
      cwd: '/p',
      cwdExists: true,
      projectName: 'p',
      title: 't',
      gitBranch: null,
      startedAt: null,
      lastActivityAt: '2026-01-01',
      messageCount: 1,
      resumeCommand: 'claude --resume x',
      safeResumeCommand: null,
    });
    expect(historySessionsEqual([s('1'), s('2')], [s('2'), s('1')])).toBe(true);
    expect(historySessionsEqual([s('1')], [s('1',)])).toBe(true);
    const changed = { ...s('1'), messageCount: 2 };
    expect(historySessionsEqual([s('1')], [changed])).toBe(false);
  });

  it('gitStatusEqual compares file lists', () => {
    const ok = {
      available: true as const,
      root: '/r',
      cwd: '/r',
      branch: { name: 'main', upstream: null, ahead: 0, behind: 0 },
      files: [{ path: 'a.ts', index: ' ', worktree: 'M' }],
      truncated: false,
    };
    expect(gitStatusEqual(ok, { ...ok, files: [...ok.files] })).toBe(true);
    expect(gitStatusEqual(ok, { ...ok, files: [{ path: 'b.ts', index: ' ', worktree: 'M' }] })).toBe(false);
  });
});

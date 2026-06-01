import { describe, it, expect } from 'vitest';
import {
  groupSessionsByProject,
  compactPath,
  OTHER_GROUP_KEY,
} from '../src/web/lib/session-group.js';
import type { Session } from '../src/shared/session.js';

function sess(partial: Partial<Session> & { id: string }): Session {
  return {
    title: partial.title ?? partial.id,
    shell: '/bin/zsh',
    cwd: partial.cwd ?? '/home/u',
    cols: 80,
    rows: 24,
    createdAt: '2026-01-01',
    lastActivityAt: '2026-01-01',
    clientCount: 0,
    exited: false,
    ...partial,
  };
}

describe('session-group', () => {
  it('compactPath keeps the last two segments', () => {
    expect(compactPath('/a/b/c/d')).toBe('…/c/d');
    expect(compactPath('/a/b')).toBe('/a/b');
    expect(compactPath('/')).toBe('/');
  });

  it('groups by live cwd, falling back to launch cwd', () => {
    const list = [
      sess({ id: '1', cwd: '/proj/a', liveCwd: '/proj/a' }),
      sess({ id: '2', cwd: '/proj/a', liveCwd: '/proj/a/src' }),
      sess({ id: '3', cwd: '/proj/b', liveCwd: null }),
    ];
    const groups = groupSessionsByProject(list);
    const keys = groups.map((g) => g.full);
    expect(keys).toEqual(['/proj/a', '/proj/a/src', '/proj/b']);
    expect(groups[0]!.sessions.map((s) => s.id)).toEqual(['1']);
    expect(groups[1]!.sessions.map((s) => s.id)).toEqual(['2']);
  });

  it('collects sessions without a cwd into the trailing "other" group', () => {
    const list = [
      sess({ id: 'x', cwd: '', liveCwd: null }),
      sess({ id: 'y', cwd: '/proj/z', liveCwd: '/proj/z' }),
    ];
    const groups = groupSessionsByProject(list);
    expect(groups[0]!.full).toBe('/proj/z');
    const other = groups[groups.length - 1]!;
    expect(other.key).toBe(OTHER_GROUP_KEY);
    expect(other.label).toBe('其他');
    expect(other.sessions.map((s) => s.id)).toEqual(['x']);
  });
});

import { describe, it, expect } from 'vitest';
import { idleTransitions } from '../src/web/lib/notifications.js';
import type { Session } from '../src/shared/session.js';

function sess(id: string, agentState: Session['agentState']): Session {
  return {
    id,
    title: id,
    shell: '/bin/zsh',
    cwd: '/home/u',
    cols: 80,
    rows: 24,
    createdAt: '2026-01-01',
    lastActivityAt: '2026-01-01',
    clientCount: 0,
    exited: false,
    agent: 'claude',
    agentState,
  };
}

describe('idleTransitions', () => {
  it('reports only active → idle transitions', () => {
    const prev = [sess('a', 'active'), sess('b', 'idle'), sess('c', 'active')];
    const next = [sess('a', 'idle'), sess('b', 'idle'), sess('c', 'active')];
    expect(idleTransitions(prev, next).map((s) => s.id)).toEqual(['a']);
  });

  it('ignores idle → active and brand-new idle sessions', () => {
    const prev = [sess('a', 'idle')];
    const next = [sess('a', 'active'), sess('new', 'idle')];
    expect(idleTransitions(prev, next)).toEqual([]);
  });

  it('does not fire when a previously active session disappears', () => {
    const prev = [sess('gone', 'active')];
    const next: Session[] = [];
    expect(idleTransitions(prev, next)).toEqual([]);
  });
});

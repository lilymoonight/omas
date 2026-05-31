import type { Session } from '../../shared/session.js';

export type SessionGroup = {
  /** Stable key for keyed `{#each}` and collapse state. */
  key: string;
  /** Compact label for the header (last path segments). */
  label: string;
  /** Full directory path (empty for the catch-all group). */
  full: string;
  sessions: Session[];
};

/** Sentinel key for sessions without a known working directory. */
export const OTHER_GROUP_KEY = '\u0000other';

/** Compact a path to its last two segments, e.g. `…/repo/src`. */
export function compactPath(p: string): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if (parts.length <= 2) return '/' + parts.join('/');
  return '…/' + parts.slice(-2).join('/');
}

/**
 * Group sessions by their live working directory (falling back to launch cwd),
 * so multiple agents/tasks in the same project cluster together. Groups are
 * sorted by path; sessions inside keep the server order. The catch-all "other"
 * group (no cwd) always sorts last. Pure — unit-testable without a DOM.
 */
export function groupSessionsByProject(list: Session[]): SessionGroup[] {
  const map = new Map<string, SessionGroup>();
  for (const s of list) {
    const full = (s.liveCwd ?? s.cwd ?? '').trim();
    const key = full || OTHER_GROUP_KEY;
    let g = map.get(key);
    if (!g) {
      // Show the full path so the label is as informative as possible; the
      // header CSS truncates with an ellipsis only when it can't fit.
      g = { key, full, label: full || '其他', sessions: [] };
      map.set(key, g);
    }
    g.sessions.push(s);
  }
  return [...map.values()].sort((a, b) => {
    if (a.key === OTHER_GROUP_KEY) return 1;
    if (b.key === OTHER_GROUP_KEY) return -1;
    return a.full.localeCompare(b.full);
  });
}

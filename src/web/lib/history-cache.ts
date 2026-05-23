import { api, type HistorySession } from './api.js';
import { historySessionsEqual } from './stable-update.js';

export type HistorySnapshot = {
  sessions: HistorySession[];
  lastFetchAt: number;
  error: string | null;
};

const CHANNEL = 'omas-history-refresh';

let snapshot: HistorySnapshot = { sessions: [], lastFetchAt: 0, error: null };
let inFlight = false;
const listeners = new Set<(snap: HistorySnapshot) => void>();

let channel: BroadcastChannel | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

function emit(): void {
  for (const fn of listeners) fn(snapshot);
}

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void refreshHistoryCache({ silent: true }), 200);
  };
}

/** Subscribe to history cache updates. Returns unsubscribe. */
export function subscribeHistory(fn: (snap: HistorySnapshot) => void): () => void {
  ensureChannel();
  listeners.add(fn);
  fn(snapshot);
  return () => listeners.delete(fn);
}

export function getHistorySnapshot(): HistorySnapshot {
  return snapshot;
}

export async function refreshHistoryCache(opts: { silent?: boolean; force?: boolean } = {}): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await api.history({ refresh: opts.force });
    const changed = !historySessionsEqual(snapshot.sessions, res.sessions);
    if (changed || snapshot.lastFetchAt === 0) {
      snapshot = { sessions: res.sessions, lastFetchAt: Date.now(), error: null };
      emit();
    }
    // Unchanged payload: do not touch snapshot — avoids pointless re-renders.
  } catch (e) {
    if (!opts.silent) {
      snapshot = { ...snapshot, error: `读取失败：${e}` };
      emit();
    }
  } finally {
    inFlight = false;
  }
}

/** Terminal tab closed — user likely finished an agent session; refresh for history. */
export function refreshHistoryAfterSessionClose(): void {
  ensureChannel();
  try {
    channel?.postMessage({ type: 'session-closed', at: Date.now() });
  } catch {
    /* popup may be cross-origin restricted in edge cases */
  }
  void refreshHistoryCache({ silent: true });
}

import { writable } from 'svelte/store';
import type { Session } from '../../shared/session.js';
import { api, apiBase, type UserPublic } from './api.js';
import { sessionsEqual } from './stable-update.js';
import { backgroundPollWanted } from './notifications.js';

export type AuthState = 'unknown' | 'in' | 'out';
export const auth = writable<AuthState>('unknown');

/** Logged-in account (multi-user mode), or null in open/single-user mode. */
export const currentUser = writable<UserPublic | null>(null);
/** True when the server has named accounts (login requires a username). */
export const multiUser = writable<boolean>(false);

export async function checkAuth(): Promise<void> {
  try {
    const res = await fetch(apiBase + 'auth/me', { credentials: 'same-origin' });
    const data = await res.json();
    multiUser.set(!!data.multiUser);
    currentUser.set(data.user ?? null);
    if (data.authRequired === false) {
      auth.set('in');
      return;
    }
    auth.set(data.loggedIn ? 'in' : 'out');
  } catch {
    auth.set('out');
    currentUser.set(null);
  }
}

export const sessions = writable<Session[]>([]);

let pollTimer: ReturnType<typeof setInterval> | null = null;

export async function refreshSessions(): Promise<void> {
  try {
    const list = await api.listSessions();
    sessions.update((prev) => (sessionsEqual(prev, list) ? prev : list));
  } catch (err) {
    console.warn('refreshSessions failed', err);
  }
}

export function startSessionPolling(intervalMs = 3000): void {
  stopSessionPolling();
  void refreshSessions();
  pollTimer = setInterval(() => {
    // Keep polling while hidden only when notifications are on, so agent
    // idle transitions can still be detected and surfaced in the background.
    if (document.visibilityState === 'visible' || backgroundPollWanted()) {
      void refreshSessions();
    }
  }, intervalMs);
}

export function stopSessionPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

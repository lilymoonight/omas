import { writable } from 'svelte/store';
import type { Session } from '../../shared/session.js';
import { sessions } from './stores.js';

// Desktop notifications + tab badge for when a recognized agent stops working
// (active → idle), i.e. it likely finished or is waiting for input. This turns
// the passive card badge into something that reaches you while you're looking
// at another tab or app.

const PREF_KEY = 'omas-notify';

export type NotifyPref = 'on' | 'off';

function readPref(): NotifyPref {
  try {
    return localStorage.getItem(PREF_KEY) === 'on' ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

/** User opt-in for agent-idle notifications (persisted). */
export const notifyPref = writable<NotifyPref>(readPref());
/** How many agent sessions went idle since this tab was last focused. */
export const idlePending = writable<number>(0);

notifyPref.subscribe((v) => {
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* ignore */
  }
});

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** True while notifications are opted-in *and* the browser grants permission. */
export function notificationsActive(): boolean {
  return readPref() === 'on' && notificationsSupported() && Notification.permission === 'granted';
}

/** Used by the session poller to keep refreshing while the tab is hidden. */
export function backgroundPollWanted(): boolean {
  return notificationsActive();
}

export async function enableNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  let perm = Notification.permission;
  if (perm === 'default') {
    try {
      perm = await Notification.requestPermission();
    } catch {
      perm = Notification.permission;
    }
  }
  if (perm === 'granted') {
    notifyPref.set('on');
    return true;
  }
  notifyPref.set('off');
  return false;
}

export function disableNotifications(): void {
  notifyPref.set('off');
}

/**
 * Sessions whose recognized agent transitioned active → idle between two
 * snapshots. Pure so it can be unit-tested without a browser. A session only
 * counts if it had `agentState === 'active'` before and `=== 'idle'` now.
 */
export function idleTransitions(prev: Session[], next: Session[]): Session[] {
  const prevState = new Map(prev.map((s) => [s.id, s.agentState]));
  const out: Session[] = [];
  for (const s of next) {
    if (s.agentState === 'idle' && prevState.get(s.id) === 'active') out.push(s);
  }
  return out;
}

const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  qoder: 'Qoder',
};

function shortCwd(p: string | null | undefined): string {
  if (!p) return '';
  const parts = p.split('/').filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}

function fireIdleNotification(s: Session): void {
  if (!notificationsActive()) return;
  const agent = s.agent ? (AGENT_LABEL[s.agent] ?? s.agent) : 'Agent';
  const where = shortCwd(s.liveCwd ?? s.cwd);
  try {
    const n = new Notification(`${agent} 空闲：${s.title}`, {
      body: where ? `${where}\n可能已完成或在等待输入` : '可能已完成或在等待输入',
      // Same tag across tabs/repeats coalesces into one visible notification.
      tag: `omas-idle-${s.id}`,
      silent: false,
    });
    n.onclick = () => {
      try {
        window.open(`${location.pathname}${location.search}#/s/${s.id}`, '_blank');
      } catch {
        /* popup blocked */
      }
      window.focus();
      n.close();
    };
  } catch {
    /* construction can throw on some platforms; ignore */
  }
}

// --- Tab badge: title prefix + dynamically drawn favicon dot ----------------

let baseTitle = typeof document !== 'undefined' ? document.title : '';
let faviconEl: HTMLLinkElement | null = null;

function ensureFavicon(): HTMLLinkElement | null {
  if (typeof document === 'undefined') return null;
  if (faviconEl) return faviconEl;
  let el = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!el) {
    el = document.createElement('link');
    el.rel = 'icon';
    document.head.appendChild(el);
  }
  faviconEl = el;
  return el;
}

/** Draw a tiny terminal glyph favicon, with an accent dot when work is pending. */
function renderFavicon(dot: boolean): void {
  const link = ensureFavicon();
  if (!link || typeof document === 'undefined') return;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#0e1116';
  ctx.beginPath();
  ctx.roundRect(0, 0, 32, 32, 7);
  ctx.fill();
  ctx.strokeStyle = '#56d364';
  ctx.lineWidth = 2.6;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(8, 10);
  ctx.lineTo(14, 16);
  ctx.lineTo(8, 22);
  ctx.moveTo(16, 22);
  ctx.lineTo(24, 22);
  ctx.stroke();
  if (dot) {
    ctx.fillStyle = '#f85149';
    ctx.beginPath();
    ctx.arc(25, 7, 6, 0, Math.PI * 2);
    ctx.fill();
  }
  link.href = canvas.toDataURL('image/png');
}

function applyBadge(count: number): void {
  if (typeof document === 'undefined') return;
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
  renderFavicon(count > 0);
}

/**
 * Watch the live sessions store for agent idle transitions: fire a desktop
 * notification (when the tab is in the background) and bump the tab badge.
 * The badge clears when the user refocuses this tab. Returns a teardown fn.
 */
export function startAgentWatcher(): () => void {
  if (typeof document !== 'undefined') baseTitle = document.title;
  let prev: Session[] = [];
  let pending = 0;

  const setPending = (n: number): void => {
    pending = n;
    idlePending.set(n);
    applyBadge(n);
  };

  const unsub = sessions.subscribe((list) => {
    const transitions = idleTransitions(prev, list);
    prev = list;
    if (transitions.length === 0) return;
    const hidden = typeof document === 'undefined' || document.visibilityState === 'hidden';
    if (hidden) {
      for (const s of transitions) fireIdleNotification(s);
      setPending(pending + transitions.length);
    }
  });

  const clear = (): void => {
    if (document.visibilityState === 'visible' && pending > 0) setPending(0);
  };
  const onVisibility = (): void => clear();
  window.addEventListener('focus', clear);
  document.addEventListener('visibilitychange', onVisibility);

  return () => {
    unsub();
    window.removeEventListener('focus', clear);
    document.removeEventListener('visibilitychange', onVisibility);
    if (pending > 0) setPending(0);
  };
}

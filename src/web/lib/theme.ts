import { writable } from 'svelte/store';

export type ThemePref = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'light' | 'dark';

const KEY = 'omas-theme';
/** Cycle order for the toggle button. */
const ORDER: ThemePref[] = ['light', 'dark', 'auto'];

const media =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch {
    /* localStorage unavailable */
  }
  return 'auto';
}

function resolve(pref: ThemePref): ResolvedTheme {
  if (pref === 'auto') return media?.matches ? 'dark' : 'light';
  return pref;
}

/** User preference (light / dark / follow-system). */
export const themePref = writable<ThemePref>(readPref());
/** Effective theme after resolving `auto` against the OS setting. */
export const resolvedTheme = writable<ResolvedTheme>(resolve(readPref()));

let current: ThemePref = readPref();

function apply(pref: ThemePref): void {
  const r = resolve(pref);
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = r;
  resolvedTheme.set(r);
}

themePref.subscribe((pref) => {
  current = pref;
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  apply(pref);
});

// Re-resolve when the OS theme flips, but only while following the system.
media?.addEventListener('change', () => {
  if (current === 'auto') apply('auto');
});

/** Step the preference: light → dark → auto → light. */
export function cycleTheme(): void {
  themePref.update((p) => ORDER[(ORDER.indexOf(p) + 1) % ORDER.length]!);
}

/** Idempotent; ensures the module's side effects run from the entry point. */
export function initTheme(): void {
  apply(current);
}

export const THEME_LABEL: Record<ThemePref, string> = {
  light: '浅色',
  dark: '深色',
  auto: '跟随系统',
};

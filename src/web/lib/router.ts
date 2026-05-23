// Hash-based router so we don't have to know our base path. Routes:
//   #/            → list
//   #/s/<id>      → terminal for session <id>
//   #/login       → login page
//
// `currentRoute` is a Svelte rune store consumed by App.svelte.

import { readable } from 'svelte/store';

export type Route =
  | { name: 'list' }
  | { name: 'terminal'; id: string }
  | { name: 'history' }
  | { name: 'login' };

function parse(hash: string): Route {
  const h = hash.replace(/^#/, '');
  if (!h || h === '/') return { name: 'list' };
  if (h === '/login') return { name: 'login' };
  if (h === '/history') return { name: 'history' };
  const m = /^\/s\/([A-Za-z0-9_-]+)$/.exec(h);
  if (m) return { name: 'terminal', id: m[1]! };
  return { name: 'list' };
}

export const route = readable<Route>(parse(window.location.hash), (set) => {
  const handler = () => set(parse(window.location.hash));
  window.addEventListener('hashchange', handler);
  return () => window.removeEventListener('hashchange', handler);
});

export function navigate(to: Route): void {
  let hash = '#/';
  if (to.name === 'terminal') hash = `#/s/${to.id}`;
  else if (to.name === 'login') hash = '#/login';
  else if (to.name === 'history') hash = '#/history';
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  }
}

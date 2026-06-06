/** Normalize a path for prefix checks (POSIX-style, no trailing slash). */
export function normalizePath(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return s || '/';
}

/** True when `target` is `root` or a descendant of `root`. */
export function isPathUnder(root: string, target: string): boolean {
  const r = normalizePath(root);
  const t = normalizePath(target);
  return t === r || t.startsWith(r + '/');
}

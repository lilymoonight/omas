/** Sync the document title with the idle-notification badge prefix. */
let applyTitle: ((title: string) => void) | null = null;

export function registerDocumentTitleWriter(write: (title: string) => void): void {
  applyTitle = write;
}

/** Host part of the tab title — distinguishes tabs pointed at different omas servers. */
export function hostLabel(): string {
  if (typeof window === 'undefined') return 'omas';
  return window.location.hostname || 'localhost';
}

/** Last path segment of a directory (e.g. `/srv/agent/job1` → `job1`). */
export function folderBasename(dir: string | null | undefined): string | undefined {
  if (!dir) return undefined;
  const norm = dir.replace(/\/+$/, '');
  if (!norm) return undefined;
  const parts = norm.split('/').filter(Boolean);
  return parts[parts.length - 1] || norm;
}

export function formatTabTitle(opts?: { folder?: string; page?: string }): string {
  const bits = [hostLabel()];
  if (opts?.folder) bits.push(opts.folder);
  if (opts?.page) bits.push(opts.page);
  return bits.join(' · ');
}

export function setTabTitle(opts?: { folder?: string; page?: string }): void {
  const title = formatTabTitle(opts);
  if (applyTitle) applyTitle(title);
  else if (typeof document !== 'undefined') document.title = title;
}

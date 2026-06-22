import path from 'node:path';

export type DirEntry = {
  name: string;
  isDir: boolean;
  size: number;
  mtimeMs: number;
};

export type Breadcrumb = { label: string; href: string | null };

/** Format mtime for display (zh-CN locale, date only). */
export function formatMtime(ms: number): string {
  return new Date(ms).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/** Build breadcrumb trail from the public URL path. */
export function buildBreadcrumbs(urlPath: string, slugRootPath: string): Breadcrumb[] {
  const root = slugRootPath.endsWith('/') ? slugRootPath : `${slugRootPath}/`;
  const normalized = urlPath.endsWith('/') ? urlPath : `${urlPath}/`;

  if (normalized === root) return [{ label: '根目录', href: null }];

  const rel = normalized.startsWith(root) ? normalized.slice(root.length) : '';
  const segs = rel.split('/').filter(Boolean);
  const crumbs: Breadcrumb[] = [{ label: '根目录', href: root }];

  let prefix = root;
  for (let i = 0; i < segs.length; i++) {
    prefix += `${segs[i]}/`;
    crumbs.push({
      label: decodeURIComponent(segs[i]!),
      href: i < segs.length - 1 ? prefix : null,
    });
  }
  return crumbs;
}

/** Items sharing the latest mtime in this listing get the NEW badge. */
export function newestMtime(entries: DirEntry[]): number {
  if (entries.length === 0) return 0;
  return Math.max(...entries.map((e) => e.mtimeMs));
}

/** Calendar-day key in local time (for grouping). */
export function dateKeyLocal(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export type DateGroup = {
  dateKey: string;
  label: string;
  mtimeMs: number;
  entries: DirEntry[];
};

/** Group entries by modification date; newest date groups first. */
export function groupEntriesByDate(entries: DirEntry[]): DateGroup[] {
  const map = new Map<string, DirEntry[]>();
  for (const e of entries) {
    const key = dateKeyLocal(e.mtimeMs);
    const bucket = map.get(key);
    if (bucket) bucket.push(e);
    else map.set(key, [e]);
  }

  const groups = [...map.entries()].map(([key, items]) => {
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    const mtimeMs = Math.max(...items.map((i) => i.mtimeMs));
    return { dateKey: key, label: formatMtime(mtimeMs), mtimeMs, entries: items };
  });

  groups.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return groups;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function entryIcon(isDir: boolean): string {
  return isDir
    ? '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
    : '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11z"/></svg>';
}

function renderRow(
  href: string,
  label: string,
  isDir: boolean,
  size: string,
  extraClass = '',
): string {
  return `<a class="row ${isDir ? 'dir' : 'file'} ${extraClass}" href="${href}">
  <span class="name">${entryIcon(isDir)}<span class="label">${escapeHtml(label)}</span></span>
  <span class="size">${escapeHtml(size)}</span>
</a>`;
}

function renderEntryRow(e: DirEntry): string {
  if (e.isDir) {
    return renderRow(`${encodeURIComponent(e.name)}/`, `${e.name}/`, true, '—');
  }
  return renderRow(encodeURIComponent(e.name), e.name, false, fmtSize(e.size));
}

/** Render a self-contained HTML directory index page. */
export function renderDirListingHtml(
  urlPath: string,
  slugRootPath: string,
  entries: DirEntry[],
  showParent: boolean,
): string {
  const crumbs = buildBreadcrumbs(urlPath, slugRootPath);
  const latest = newestMtime(entries);
  const groups = groupEntriesByDate(entries);

  const listingParts: string[] = [];
  if (showParent) {
    listingParts.push(
      `<div class="nav-block">${renderRow('../', '../', true, '', 'parent')}</div>`,
    );
  }

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const isNewestDay = i === 0 && group.entries.some((e) => e.mtimeMs === latest);
    const dayBadge = isNewestDay ? '<span class="badge">NEW</span>' : '';
    const rows = group.entries.map((e) => renderEntryRow(e)).join('\n        ');
    listingParts.push(`<div class="date-group">
      <div class="date-head"><time datetime="${new Date(group.mtimeMs).toISOString()}">${escapeHtml(group.label)}</time>${dayBadge}</div>
      <div class="rows">
        <div class="row head"><span>名称</span><span>大小</span></div>
        ${rows}
      </div>
    </div>`);
  }

  const breadcrumbHtml = crumbs
    .map((c, i) => {
      const sep = i > 0 ? '<span class="sep">/</span>' : '';
      if (c.href) return `${sep}<a href="${escapeHtml(c.href)}">${escapeHtml(c.label)}</a>`;
      return `${sep}<span class="current">${escapeHtml(c.label)}</span>`;
    })
    .join('');

  const pageTitle = crumbs.map((c) => c.label).join(' / ');
  const countLabel = `${entries.length} 项`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f6f9;
    --surface: #ffffff;
    --border: rgba(15, 23, 42, 0.08);
    --text: #0f172a;
    --muted: #64748b;
    --link: #4f46e5;
    --link-hover: #4338ca;
    --row-hover: rgba(79, 70, 229, 0.06);
    --badge-bg: #ecfdf5;
    --badge-fg: #059669;
    --badge-border: rgba(5, 150, 105, 0.25);
    --icon-dir: #f59e0b;
    --icon-file: #6366f1;
    --shadow: 0 1px 3px rgba(15, 23, 42, 0.06), 0 8px 24px rgba(15, 23, 42, 0.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0b0d12;
      --surface: #141820;
      --border: rgba(148, 163, 184, 0.12);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --link: #a5b4fc;
      --link-hover: #c7d2fe;
      --row-hover: rgba(165, 180, 252, 0.08);
      --badge-bg: rgba(16, 185, 129, 0.12);
      --badge-fg: #6ee7b7;
      --badge-border: rgba(110, 231, 183, 0.25);
      --icon-dir: #fbbf24;
      --icon-file: #818cf8;
      --shadow: 0 1px 3px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.2);
    }
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px;
    line-height: 1.5;
    color: var(--text);
    background: var(--bg);
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 32px 20px 48px; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }
  .header { padding: 20px 24px 16px; border-bottom: 1px solid var(--border); }
  .breadcrumb {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    color: var(--muted);
    margin-bottom: 10px;
  }
  .breadcrumb a { color: var(--link); text-decoration: none; }
  .breadcrumb a:hover { color: var(--link-hover); text-decoration: underline; }
  .breadcrumb .current { color: var(--text); font-weight: 500; }
  .breadcrumb .sep { opacity: 0.45; user-select: none; }
  .title-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
  .meta { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .listing { padding: 8px 0 12px; }
  .nav-block { border-bottom: 1px solid var(--border); padding-bottom: 4px; margin-bottom: 4px; }
  .date-group + .date-group { border-top: 1px solid var(--border); }
  .date-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 14px 24px 6px;
    font-size: 13px;
    font-weight: 650;
    color: var(--text);
    letter-spacing: -0.01em;
  }
  .date-head time { font-variant-numeric: tabular-nums; }
  .rows { padding-bottom: 6px; }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 72px;
    gap: 12px;
    align-items: center;
    padding: 10px 24px;
    text-decoration: none;
    color: inherit;
    transition: background 0.12s ease;
  }
  .row:hover { background: var(--row-hover); }
  .row.head {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    padding-top: 4px;
    padding-bottom: 4px;
    pointer-events: none;
  }
  .row.head:hover { background: transparent; }
  .row.parent { opacity: 0.85; }
  .name { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.dir .label { font-weight: 600; }
  .icon { width: 18px; height: 18px; flex-shrink: 0; }
  .row.dir .icon { color: var(--icon-dir); }
  .row.file .icon { color: var(--icon-file); }
  .size { font-size: 12px; color: var(--muted); text-align: right; white-space: nowrap; }
  .badge {
    flex-shrink: 0;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 999px;
    color: var(--badge-fg);
    background: var(--badge-bg);
    border: 1px solid var(--badge-border);
  }
  @media (max-width: 560px) {
    .row { grid-template-columns: minmax(0, 1fr) 64px; }
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <header class="header">
      <nav class="breadcrumb" aria-label="目录">${breadcrumbHtml}</nav>
      <div class="title-row">
        <h1>文件目录</h1>
        <span class="meta">${escapeHtml(countLabel)}</span>
      </div>
    </header>
    <div class="listing">
      ${listingParts.join('\n      ')}
    </div>
  </div>
</div>
</body>
</html>`;
}

/** Collect directory entries with stat metadata (parallel). */
export async function collectDirEntries(
  absDir: string,
  readdir: typeof import('node:fs/promises').readdir,
  stat: typeof import('node:fs/promises').stat,
): Promise<DirEntry[] | null> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const classified = await Promise.all(
    names.map(async (d) => {
      const absPath = path.join(absDir, d.name);
      try {
        const st = await stat(absPath);
        return {
          name: d.name,
          isDir: st.isDirectory(),
          size: st.isDirectory() ? 0 : st.size,
          mtimeMs: st.mtimeMs,
        } satisfies DirEntry;
      } catch {
        return null;
      }
    }),
  );

  return classified.filter((e): e is DirEntry => e !== null);
}

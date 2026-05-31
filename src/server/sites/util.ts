import path from 'node:path';

// Pure helpers for the public static-site hosting feature. Kept free of fs/
// fastify so they can be unit-tested in isolation.

export type SiteSpec = {
  /** URL slug under /p/<slug>/. */
  slug: string;
  /** Filesystem directory to serve (may be relative; resolved later). */
  root: string;
  /** Fall back to index.html for unknown paths (single-page apps). */
  spa: boolean;
};

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 64 && SLUG_RE.test(slug);
}

/**
 * Parse `--publish slug=dir` (and `--publish-spa slug=dir`) CLI values into
 * site specs. Throws on malformed entries so the operator gets a clear error
 * instead of a silently-ignored mount. Duplicate slugs: last one wins.
 */
export function parsePublishArgs(plain: string[], spa: string[]): SiteSpec[] {
  const bySlug = new Map<string, SiteSpec>();
  const add = (raw: string, isSpa: boolean): void => {
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      throw new Error(`--publish 需要 slug=目录 格式，收到：${JSON.stringify(raw)}`);
    }
    const slug = raw.slice(0, eq).trim();
    const root = raw.slice(eq + 1).trim();
    if (!isValidSlug(slug)) {
      throw new Error(`无效的站点 slug：${JSON.stringify(slug)}（只允许字母数字、. _ -，且不以符号开头）`);
    }
    if (!root) {
      throw new Error(`站点 ${JSON.stringify(slug)} 缺少目录路径`);
    }
    bySlug.set(slug, { slug, root, spa: isSpa });
  };
  for (const v of plain) add(v, false);
  for (const v of spa) add(v, true);
  return [...bySlug.values()];
}

/**
 * Merge specs from config.json with CLI specs (CLI wins on slug collision) and
 * drop duplicates. Order: config first, then CLI overrides.
 */
export function mergeSiteSpecs(fromConfig: SiteSpec[], fromCli: SiteSpec[]): SiteSpec[] {
  const bySlug = new Map<string, SiteSpec>();
  for (const s of fromConfig) bySlug.set(s.slug, s);
  for (const s of fromCli) bySlug.set(s.slug, s);
  return [...bySlug.values()];
}

/**
 * Resolve a request path within a site root, refusing anything that escapes the
 * root (path traversal, absolute paths, NUL bytes). Returns the absolute path
 * or null when the request must be rejected.
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  if (rel.includes('\0')) return null;
  const rootResolved = path.resolve(root);
  // path.resolve drops `root` if `rel` is absolute, so a leading slash can't
  // be used to escape; the containment check below still guards `..`.
  const abs = path.resolve(rootResolved, rel);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) return null;
  return abs;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.csv': 'text/csv; charset=utf-8',
};

export function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

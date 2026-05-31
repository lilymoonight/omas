import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { logger } from '../logger.js';
import { mimeFor, resolveWithinRoot } from './util.js';
import { SiteError, type ResolvedSite, type SiteManager } from './manager.js';

// Loose Fastify shape, matching the other route modules in this codebase.
type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  post: (path: string, handler: (req: any, reply: any) => any) => unknown;
  delete: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

const createSchema = z.object({
  slug: z.string().min(1).max(64),
  root: z.string().min(1).max(4096),
  spa: z.boolean().optional(),
});

function siteJson(site: ResolvedSite, mgr: SiteManager) {
  return { slug: site.slug, url: `/p/${site.slug}/`, root: site.root, spa: site.spa, cli: mgr.isCli(site.slug) };
}

function sendFile(reply: any, abs: string, size: number): unknown {
  reply.header('content-type', mimeFor(abs));
  reply.header('content-length', size);
  // Work results change between rebuilds; force revalidation so a refresh
  // always shows the latest output rather than a stale cached asset.
  reply.header('cache-control', 'no-cache');
  reply.header('x-content-type-options', 'nosniff');
  return reply.send(fs.createReadStream(abs));
}

function notFound(reply: any): unknown {
  return reply.code(404).type('text/plain; charset=utf-8').send('404 Not Found');
}

function serveIndexFallback(reply: any, site: ResolvedSite): unknown {
  const index = path.join(site.root, 'index.html');
  try {
    const st = fs.statSync(index);
    if (st.isFile()) return sendFile(reply, index, st.size);
  } catch {
    /* no index */
  }
  return notFound(reply);
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

/**
 * Render a Python `http.server`-style directory index for a folder that has no
 * `index.html`. `urlPath` is the request path (already ending in `/`) and is
 * used both to build relative links and to know whether a parent link applies.
 */
function renderDirListing(reply: any, absDir: string, urlPath: string, slugRootPath: string): unknown {
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return notFound(reply);
  }

  const dirs: fs.Dirent[] = [];
  const files: fs.Dirent[] = [];
  for (const d of names) {
    // Resolve symlinks so a link to a directory still sorts/links correctly.
    let isDir = d.isDirectory();
    if (d.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(absDir, d.name)).isDirectory();
      } catch {
        continue;
      }
    }
    (isDir ? dirs : files).push(d);
  }
  const byName = (a: fs.Dirent, b: fs.Dirent) => a.name.localeCompare(b.name, undefined, { numeric: true });
  dirs.sort(byName);
  files.sort(byName);

  const rows: string[] = [];
  // A parent link, unless we are already at the site root.
  if (urlPath.replace(/\/+$/, '/') !== slugRootPath) {
    rows.push('<li class="dir"><a href="../">../</a></li>');
  }
  for (const d of dirs) {
    const enc = encodeURIComponent(d.name);
    rows.push(`<li class="dir"><a href="${enc}/">${escapeHtml(d.name)}/</a></li>`);
  }
  for (const f of files) {
    const enc = encodeURIComponent(f.name);
    let size = '';
    try {
      size = fmtSize(fs.statSync(path.join(absDir, f.name)).size);
    } catch {
      /* ignore */
    }
    rows.push(
      `<li class="file"><a href="${enc}">${escapeHtml(f.name)}</a><span class="size">${size}</span></li>`,
    );
  }

  const title = escapeHtml(decodeURIComponent(urlPath));
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Index of ${title}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin: 0; padding: 24px; line-height: 1.6; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 16px; word-break: break-all; }
  ul { list-style: none; margin: 0; padding: 0; max-width: 760px; }
  li { display: flex; justify-content: space-between; gap: 16px; padding: 2px 8px; border-radius: 6px; }
  li:hover { background: rgba(127,127,127,0.12); }
  a { text-decoration: none; }
  a:hover { text-decoration: underline; }
  .dir a { font-weight: 600; }
  .size { opacity: 0.55; font-size: 12px; white-space: nowrap; }
</style>
</head>
<body>
<h1>Index of ${title}</h1>
<ul>
${rows.join('\n')}
</ul>
</body>
</html>`;
  reply.header('content-type', 'text/html; charset=utf-8');
  reply.header('cache-control', 'no-cache');
  return reply.send(html);
}

/**
 * Register the public, no-auth static routes (`/p/<slug>/...`) plus the authed
 * `/api/sites` CRUD. Public routes are always registered and read the live
 * registry per request, so sites added/removed via the API work without a
 * restart. Public content lives outside `/api/`, so the auth guard ignores it.
 */
export function registerSiteRoutes(app: App, mgr: SiteManager): void {
  // --- Authed management (under /api/, guarded by the auth hook) ---

  app.get('/api/sites', async () => ({
    canPersist: mgr.canPersist,
    sites: mgr.list().map((s) => siteJson(s, mgr)),
  }));

  app.post('/api/sites', async (req: any, reply: any) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      const site = mgr.addOrUpdate({ slug: parsed.data.slug, root: parsed.data.root, spa: !!parsed.data.spa });
      return reply.code(201).send(siteJson(site, mgr));
    } catch (err) {
      if (err instanceof SiteError) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.delete('/api/sites/:slug', async (req: any, reply: any) => {
    const slug = String(req.params.slug);
    try {
      if (!mgr.remove(slug)) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    } catch (err) {
      if (err instanceof SiteError) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // --- Public static content (no auth) ---

  // Bare `/p/<slug>` → redirect to `/p/<slug>/` so relative asset URLs resolve.
  app.get('/p/:slug', async (req: any, reply: any) => {
    if (!mgr.get(String(req.params.slug))) return notFound(reply);
    return redirectWithSlash(req, reply);
  });

  app.get('/p/:slug/*', async (req: any, reply: any) => {
    const site = mgr.get(String(req.params.slug));
    if (!site) return notFound(reply);

    const rest = decodeRel(req.params['*'] ?? '');
    if (rest === null) return reply.code(400).type('text/plain; charset=utf-8').send('400 Bad Request');

    const abs = resolveWithinRoot(site.root, rest);
    if (abs === null) return reply.code(403).type('text/plain; charset=utf-8').send('403 Forbidden');

    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      return site.spa ? serveIndexFallback(reply, site) : notFound(reply);
    }

    if (st.isDirectory()) {
      const pathPart = String(req.url).split('?')[0] ?? '';
      if (!pathPart.endsWith('/')) return redirectWithSlash(req, reply);
      const index = path.join(abs, 'index.html');
      try {
        const ist = fs.statSync(index);
        if (ist.isFile()) return sendFile(reply, index, ist.size);
      } catch {
        /* no index in this dir */
      }
      // SPA sites route every missing path back to their root index.html;
      // plain sites fall back to a Python-style browsable directory listing.
      return site.spa ? serveIndexFallback(reply, site) : renderDirListing(reply, abs, pathPart, `/p/${site.slug}/`);
    }

    if (st.isFile()) return sendFile(reply, abs, st.size);
    return notFound(reply);
  });

  const initial = mgr.list();
  if (initial.length > 0) {
    logger.info({ sites: initial.map((s) => `/p/${s.slug}/ → ${s.root}`) }, 'serving public static sites (no auth)');
  }
}

function redirectWithSlash(req: any, reply: any): unknown {
  const [base, query] = String(req.url).split('?');
  return reply.redirect(`${base}/${query ? '?' + query : ''}`, 301);
}

/** Decode a percent-encoded path segment list; null on malformed/NUL input. */
function decodeRel(raw: string): string | null {
  try {
    const dec = decodeURIComponent(raw);
    if (dec.includes('\0')) return null;
    return dec;
  } catch {
    return null;
  }
}

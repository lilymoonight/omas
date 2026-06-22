import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { z } from 'zod';
import { logger } from '../logger.js';
import { collectDirEntries, renderDirListingHtml } from './dir-listing.js';
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
});

function siteJson(site: ResolvedSite, mgr: SiteManager) {
  return { slug: site.slug, url: `/p/${site.slug}/`, root: site.root, cli: mgr.isCli(site.slug) };
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

/**
 * Render a browsable directory index with breadcrumb navigation, date grouping,
 * and a NEW badge on the most recent date section.
 */
async function renderDirListing(reply: any, absDir: string, urlPath: string, slugRootPath: string): Promise<unknown> {
  const entries = await collectDirEntries(absDir, fsp.readdir, fsp.stat);
  if (entries === null) return notFound(reply);

  const normalizedUrl = urlPath.replace(/\/+$/, '/');
  const normalizedRoot = slugRootPath.replace(/\/+$/, '/');
  const showParent = normalizedUrl !== normalizedRoot;

  const html = renderDirListingHtml(urlPath, slugRootPath, entries, showParent);
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
      const site = mgr.addOrUpdate({ slug: parsed.data.slug, root: parsed.data.root });
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
      st = await fsp.stat(abs);
    } catch {
      return notFound(reply);
    }

    if (st.isDirectory()) {
      const pathPart = String(req.url).split('?')[0] ?? '';
      if (!pathPart.endsWith('/')) return redirectWithSlash(req, reply);
      return renderDirListing(reply, abs, pathPart, `/p/${site.slug}/`);
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

import Fastify from 'fastify';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import { logger } from './logger.js';
import { SessionHub } from './pty/hub.js';
import { ensureReady as ensurePtyBackendReady } from './pty/backend.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerGitRoutes } from './routes/git-status.js';
import { registerGitFileRoutes } from './routes/git-file.js';
import { registerFsRoutes } from './routes/fs.js';
import { registerShareRoutes } from './routes/share.js';
import { ShareStore } from './share/store.js';
import { registerHistoryRoutes } from './history/index.js';
import { installWsUpgrade } from './ws/upgrade.js';
import { loadConfig, resolveConfigDir, isAuthRequired, type Config } from './config.js';
import { CookieSessionStore } from './auth/sessions.js';
import { LoginLimiter } from './auth/limiter.js';
import { registerAuthRoutes, makeAuthGuard, isAuthedFromRawHeaders } from './auth/routes.js';
import { autoInitConfig } from './auth/auto-init.js';
import { resolveDefaultCwd } from './pty/default-cwd.js';
import { UploadStore } from './pty/upload-store.js';
import { parsePublishArgs, type SiteSpec } from './sites/util.js';
import { SiteManager } from './sites/manager.js';
import { registerSiteRoutes } from './sites/routes.js';

export type ServerConfig = {
  host: string;
  port: number;
  shell?: string;
  cwd?: string;
  configDir?: string;
  maxSessions: number;
  scrollbackBytes: number;
  /** Plaintext password from --password flag. Memory-only, never persisted. */
  passwordInline?: string;
  /** Path to a file containing the password (will be read + trimmed). */
  passwordFile?: string;
  /** `slug=dir` entries from --publish (no-auth static sites). */
  publish?: string[];
  /** `slug=dir` entries from --publish-spa (no-auth SPA sites). */
  publishSpa?: string[];
};

export async function createServer(config: ServerConfig) {
  const dir = resolveConfigDir(config.configDir);
  let cfg: Config | null = loadConfig(dir);
  // Disk-backed config can always be re-saved. Memory-only configs can't safely
  // persist a password hash, so site-config writes are gated on this below.
  const diskBacked = cfg !== null;
  // When --password or --password-file is given, always use that (don't fall
  // through to whatever's persisted on disk). This makes the flag predictable.
  if (config.passwordInline || config.passwordFile) {
    cfg = (await autoInitConfig(dir, { passwordInline: config.passwordInline, passwordFile: config.passwordFile })).config;
  } else if (!cfg) {
    // No persisted config — auto-pick from env / TTY / random.
    cfg = (await autoInitConfig(dir)).config;
  }

  // Resolve the runtime-specific PTY backend (Bun shim under Bun, node-pty under Node)
  // before any session can be created.
  await ensurePtyBackendReady();

  const defaultCwd = resolveDefaultCwd({
    explicit: config.cwd,
    env: process.env.OMAS_CWD,
    config: cfg?.defaultCwd,
  });
  logger.info({ defaultCwd }, 'new sessions default cwd');

  const app = Fastify({ loggerInstance: logger, disableRequestLogging: true, trustProxy: true });
  await app.register(fastifyCookie, { secret: cfg.cookieSecret });

  const store = new CookieSessionStore();
  const limiter = new LoginLimiter();

  registerAuthRoutes(app, { config: cfg, store, limiter });
  app.addHook('preHandler', makeAuthGuard(cfg, store));

  const hub = new SessionHub({
    maxSessions: config.maxSessions,
    scrollbackBytes: config.scrollbackBytes,
    defaultShell: config.shell,
    defaultCwd,
  });

  app.get('/api/health', async () => ({
    ok: true,
    uptime: process.uptime(),
    sessions: hub.list().length,
    defaultCwd,
  }));

  const uploads = new UploadStore();
  const shares = new ShareStore();

  registerSessionRoutes(app, hub);
  registerSystemRoutes(app);
  registerGitRoutes(app, hub);
  registerGitFileRoutes(app, hub);
  registerFsRoutes(app, hub, uploads);
  registerShareRoutes(app, hub, shares);
  registerHistoryRoutes(app);
  installWsUpgrade(
    app.server,
    hub,
    (req) => !isAuthRequired(cfg) || isAuthedFromRawHeaders(req, store),
    shares,
  );

  // Public, no-auth static sites (/p/<slug>/). Persistent entries live in
  // config.json (editable via /api/sites + the publish page); --publish flags
  // add ephemeral ones on top. Saving site config to disk is only allowed when
  // we won't accidentally persist a memory-only password.
  let cliSpecs: SiteSpec[] = [];
  try {
    cliSpecs = parsePublishArgs(config.publish ?? [], config.publishSpa ?? []);
  } catch (err) {
    logger.error({ err: (err as Error).message }, 'invalid --publish argument');
    throw err;
  }
  const canPersistSites = diskBacked || !cfg.passwordHash;
  const siteManager = new SiteManager(dir, cfg, cliSpecs, canPersistSites);
  registerSiteRoutes(app, siteManager);

  // Web assets: prefer the embedded manifest (single-binary case) — it ships
  // inside the binary and survives compile-time. Fall back to disk for normal
  // Node dev/prod runs.
  let embedded: typeof import('./web-assets.gen.js')['embeddedAssets'] | null = null;
  try {
    embedded = (await import('./web-assets.gen.js')).embeddedAssets;
  } catch { /* not generated — we'll fall through to disk */ }

  if (embedded && embedded.count > 0) {
    // Serve each embedded URL directly; index.html doubles as the SPA fallback.
    for (const url of embedded.urls()) {
      app.get(url, async (_req: any, reply: any) => {
        const a = embedded!.get(url)!;
        reply.header('content-type', a.mime);
        reply.header('cache-control', url.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
        return reply.send(a.body);
      });
    }
    app.setNotFoundHandler((req: any, reply: any) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const idx = embedded!.get('/index.html');
      if (!idx) return reply.code(404).send({ error: 'not_found' });
      reply.header('content-type', idx.mime);
      // The SPA entry must always revalidate; otherwise browsers heuristically
      // cache it and keep loading old (hashed) asset bundles after a redeploy.
      reply.header('cache-control', 'no-cache');
      return reply.send(idx.body);
    });
    logger.info({ files: embedded.count }, 'serving embedded web assets');
  } else {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webRoot = path.resolve(here, '../web');
    if (fs.existsSync(webRoot)) {
      await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.method !== 'GET' || req.url.startsWith('/api/')) {
          return reply.code(404).send({ error: 'not_found' });
        }
        return reply.sendFile('index.html');
      });
    } else {
      logger.warn({ webRoot }, 'web dist not built yet — only /api routes available');
    }
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    store.shutdown();
    await uploads.shutdown();
    await hub.shutdownAll();
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  return { app, hub, store };
}

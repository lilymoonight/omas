import { scan as scanClaude } from './claude.js';
import { scan as scanQoder } from './qoder.js';
import { scan as scanCursor } from './cursor.js';
import { scan as scanOpencode } from './opencode.js';
import { aiSafeAvailable, annotateSafeCommand } from './safe.js';
import type { HistorySession, HistorySource } from './types.js';
import { logger } from '../logger.js';

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

const SCANNERS: Record<HistorySource, () => Promise<HistorySession[]>> = {
  'claude-code': scanClaude,
  qoder: scanQoder,
  'cursor-agent': scanCursor,
  opencode: scanOpencode,
};

async function scanSource(src: HistorySource): Promise<HistorySession[]> {
  try {
    return await SCANNERS[src]();
  } catch (err) {
    logger.warn({ err, src }, 'history scan failed');
    return [];
  }
}

export function registerHistoryRoutes(app: App): void {
  // Aggregate scan across all known sources. Each scanner returns [] when its
  // data dir is missing, so users who only use a subset still get useful results.
  app.get('/api/history', async (req: any) => {
    const filter = (req.query?.source as string | undefined)?.split(',').filter(Boolean) as HistorySource[] | undefined;
    const sources = (filter && filter.length ? filter : (Object.keys(SCANNERS) as HistorySource[]));
    const [results, safe] = await Promise.all([
      Promise.all(sources.map((s) => scanSource(s))),
      aiSafeAvailable(),
    ]);
    const merged = annotateSafeCommand(results.flat(), safe);
    merged.sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt));
    return { sessions: merged, aiSafeAvailable: safe };
  });

  // Legacy alias — used by older builds of the SPA, kept so cached frontends
  // don't 404 mid-rollout.
  app.get('/api/history/claude', async () => {
    const [s, safe] = await Promise.all([scanSource('claude-code'), aiSafeAvailable()]);
    return { sessions: annotateSafeCommand(s, safe) };
  });
}

import { scan as scanClaude } from './claude.js';
import { scan as scanQoder } from './qoder.js';
import { scan as scanCursor } from './cursor.js';
import { scan as scanOpencode } from './opencode.js';
import { aiSafeAvailable, annotateSafeCommand } from './safe.js';
import type { HistorySession, HistorySource } from './types.js';
import { logger } from '../logger.js';

const TTL_MS = 30_000;

const SCANNERS: Record<HistorySource, () => Promise<HistorySession[]>> = {
  'claude-code': scanClaude,
  qoder: scanQoder,
  'cursor-agent': scanCursor,
  opencode: scanOpencode,
};

type CacheEntry = {
  at: number;
  key: string;
  sessions: HistorySession[];
  aiSafeAvailable: boolean;
};

let cache: CacheEntry | null = null;

function cacheKey(sources: HistorySource[]): string {
  return [...sources].sort().join(',');
}

async function scanSource(src: HistorySource): Promise<HistorySession[]> {
  try {
    return await SCANNERS[src]();
  } catch (err) {
    logger.warn({ err, src }, 'history scan failed');
    return [];
  }
}

export type HistoryResult = {
  sessions: HistorySession[];
  aiSafeAvailable: boolean;
};

export async function fetchHistory(
  sources: HistorySource[],
  opts: { refresh?: boolean } = {},
): Promise<HistoryResult> {
  const key = cacheKey(sources);
  const now = Date.now();
  if (!opts.refresh && cache && cache.key === key && now - cache.at < TTL_MS) {
    return { sessions: cache.sessions, aiSafeAvailable: cache.aiSafeAvailable };
  }

  const [results, safe] = await Promise.all([
    Promise.all(sources.map((s) => scanSource(s))),
    aiSafeAvailable(),
  ]);
  const merged = annotateSafeCommand(results.flat(), safe);
  merged.sort((a, b) => +new Date(b.lastActivityAt) - +new Date(a.lastActivityAt));

  cache = { at: now, key, sessions: merged, aiSafeAvailable: safe };
  return { sessions: merged, aiSafeAvailable: safe };
}

/** Test helper — reset in-memory cache between cases. */
export function clearHistoryCache(): void {
  cache = null;
}

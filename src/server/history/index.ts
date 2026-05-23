import { fetchHistory } from './cache.js';
import type { HistorySource } from './types.js';

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

const ALL_SOURCES = ['claude-code', 'qoder', 'cursor-agent', 'opencode'] as HistorySource[];

export function registerHistoryRoutes(app: App): void {
  app.get('/api/history', async (req: any) => {
    const filter = (req.query?.source as string | undefined)?.split(',').filter(Boolean) as HistorySource[] | undefined;
    const sources = filter?.length ? filter : ALL_SOURCES;
    const refresh = req.query?.refresh === '1' || req.query?.refresh === 'true';
    return fetchHistory(sources, { refresh });
  });

  // Legacy alias — used by older builds of the SPA, kept so cached frontends
  // don't 404 mid-rollout.
  app.get('/api/history/claude', async () => {
    return fetchHistory(['claude-code']);
  });
}

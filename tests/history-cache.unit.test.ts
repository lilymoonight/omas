import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchHistory, clearHistoryCache } from '../src/server/history/cache.js';

vi.mock('../src/server/history/claude.js', () => ({
  scan: vi.fn(async () => [{ id: 'a', source: 'claude-code' } as any]),
}));
vi.mock('../src/server/history/qoder.js', () => ({
  scan: vi.fn(async () => []),
}));
vi.mock('../src/server/history/cursor.js', () => ({
  scan: vi.fn(async () => []),
}));
vi.mock('../src/server/history/opencode.js', () => ({
  scan: vi.fn(async () => []),
}));
vi.mock('../src/server/history/safe.js', () => ({
  aiSafeAvailable: vi.fn(async () => false),
  annotateSafeCommand: vi.fn((sessions: unknown[]) => sessions),
}));

import { scan as scanClaude } from '../src/server/history/claude.js';

describe('fetchHistory cache', () => {
  beforeEach(() => {
    clearHistoryCache();
    vi.mocked(scanClaude).mockClear();
  });

  it('reuses scan results within TTL', async () => {
    await fetchHistory(['claude-code']);
    await fetchHistory(['claude-code']);
    expect(scanClaude).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when refresh is requested', async () => {
    await fetchHistory(['claude-code']);
    await fetchHistory(['claude-code'], { refresh: true });
    expect(scanClaude).toHaveBeenCalledTimes(2);
  });

  it('uses separate cache entries per source filter', async () => {
    await fetchHistory(['claude-code']);
    await fetchHistory(['claude-code', 'qoder']);
    expect(scanClaude).toHaveBeenCalledTimes(2);
  });
});

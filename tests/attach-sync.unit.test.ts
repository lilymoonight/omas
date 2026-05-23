import { describe, it, expect } from 'vitest';
import { canSyncTermSize } from '../src/web/lib/attach-sync.js';

describe('canSyncTermSize', () => {
  it('blocks resize during connect and restore', () => {
    expect(canSyncTermSize('connecting')).toBe(false);
    expect(canSyncTermSize('restoring')).toBe(false);
  });

  it('allows resize once attach is ready', () => {
    expect(canSyncTermSize('ready')).toBe(true);
  });
});

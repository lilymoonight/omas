import { describe, it, expect, vi } from 'vitest';
import { concatUint8, createTermWriteBatch } from '../src/web/lib/term-write-batch.js';

describe('term-write-batch', () => {
  it('concatUint8 merges chunks', () => {
    const out = concatUint8([new Uint8Array([1, 2]), new Uint8Array([3])]);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('flush merges queued chunks', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const writes: Uint8Array[] = [];
    const batch = createTermWriteBatch((data) => writes.push(data));
    batch.push(new Uint8Array([1]));
    batch.push(new Uint8Array([2, 3]));
    batch.flush();
    expect(writes).toHaveLength(1);
    expect(Array.from(writes[0]!)).toEqual([1, 2, 3]);
    batch.dispose();
    vi.unstubAllGlobals();
  });
});

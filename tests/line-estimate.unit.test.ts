import { describe, it, expect } from 'vitest';
import { estimateJsonlLines } from '../src/server/history/line-estimate.js';

describe('estimateJsonlLines', () => {
  it('returns 0 for empty files', () => {
    expect(estimateJsonlLines(0)).toBe(0);
  });

  it('estimates from byte size', () => {
    expect(estimateJsonlLines(2800)).toBe(10);
  });
});

import { describe, it, expect } from 'vitest';
import { estimateTermSize } from '../src/web/lib/term-size.js';

describe('estimateTermSize', () => {
  it('subtracts side panels from width', () => {
    const { cols } = estimateTermSize({ width: 1400, height: 900 });
    expect(cols).toBeGreaterThan(80);
    expect(cols).toBeLessThan(140);
  });

  it('clamps to a sensible minimum', () => {
    const { cols, rows } = estimateTermSize({ width: 400, height: 300 });
    expect(cols).toBe(80);
    expect(rows).toBe(24);
  });
});

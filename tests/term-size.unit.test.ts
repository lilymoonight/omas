import { describe, it, expect } from 'vitest';
import {
  CELL_H,
  CELL_W,
  CHROME_X,
  CHROME_Y,
  sidePanelsForViewport,
} from '../src/web/lib/term-layout.js';
import { estimateTermSize } from '../src/web/lib/term-size.js';

describe('term-layout', () => {
  it('reserves no side panel width (default collapsed)', () => {
    expect(sidePanelsForViewport(1280)).toBe(0);
    expect(sidePanelsForViewport(767)).toBe(0);
  });
});

describe('estimateTermSize', () => {
  it('uses full terminal width when side panels are collapsed', () => {
    const { cols } = estimateTermSize({ width: 1400, height: 900 });
    const innerW = 1400 - CHROME_X;
    expect(cols).toBe(Math.max(80, Math.min(320, Math.floor(innerW / CELL_W))));
  });

  it('scales cols with viewport width', () => {
    const narrow = estimateTermSize({ width: 767, height: 900 });
    const wide = estimateTermSize({ width: 1400, height: 900 });
    expect(wide.cols).toBeGreaterThan(narrow.cols);
  });

  it('clamps to a sensible minimum', () => {
    const { cols, rows } = estimateTermSize({ width: 400, height: 300 });
    expect(cols).toBe(80);
    expect(rows).toBe(24);
  });

  it('matches layout formula for rows', () => {
    const h = 900;
    const { rows } = estimateTermSize({ width: 1400, height: h });
    const expected = Math.max(24, Math.min(120, Math.floor((h - CHROME_Y) / CELL_H)));
    expect(rows).toBe(expected);
  });
});

import { describe, it, expect } from 'vitest';
import {
  CELL_H,
  CELL_W,
  CHROME_X,
  CHROME_Y,
  SIDE_PANELS_DESKTOP,
  sidePanelsForViewport,
} from '../src/web/lib/term-layout.js';
import { estimateTermSize } from '../src/web/lib/term-size.js';

describe('term-layout', () => {
  it('uses full width side panels on desktop', () => {
    expect(sidePanelsForViewport(1280)).toBe(SIDE_PANELS_DESKTOP);
  });

  it('drops side panels on narrow viewports', () => {
    expect(sidePanelsForViewport(767)).toBe(0);
  });
});

describe('estimateTermSize', () => {
  it('subtracts side panels from width on desktop', () => {
    const { cols } = estimateTermSize({ width: 1400, height: 900 });
    const innerW = 1400 - SIDE_PANELS_DESKTOP - CHROME_X;
    expect(cols).toBe(Math.max(80, Math.min(320, Math.floor(innerW / CELL_W))));
  });

  it('uses full terminal width on narrow viewports', () => {
    const narrow = estimateTermSize({ width: 767, height: 900 });
    const desktop = estimateTermSize({ width: 768, height: 900 });
    expect(narrow.cols).toBeGreaterThan(desktop.cols);
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

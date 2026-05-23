import {
  CELL_H,
  CELL_W,
  CHROME_X,
  CHROME_Y,
  sidePanelsForViewport,
} from './term-layout.js';

/** Rough PTY size when creating a session, before FitAddon measures the live terminal. */
export function estimateTermSize(viewport?: { width: number; height: number }): {
  cols: number;
  rows: number;
} {
  const w = viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const h = viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 800);
  const sidePanels = sidePanelsForViewport(w);

  const cols = Math.max(80, Math.min(320, Math.floor((w - sidePanels - CHROME_X) / CELL_W)));
  const rows = Math.max(24, Math.min(120, Math.floor((h - CHROME_Y) / CELL_H)));
  return { cols, rows };
}

/** Rough PTY size when creating a session, before FitAddon measures the live terminal. */
export function estimateTermSize(viewport?: { width: number; height: number }): {
  cols: number;
  rows: number;
} {
  const w = viewport?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 1280);
  const h = viewport?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 800);

  // Terminal page: FilesPanel 260px + GitPanel 300px + chrome/padding ≈ 560px.
  const SIDE_PANELS = 560;
  const CHROME_X = 48;
  const CHROME_Y = 110;
  const CELL_W = 8;
  const CELL_H = 18;

  const cols = Math.max(80, Math.min(320, Math.floor((w - SIDE_PANELS - CHROME_X) / CELL_W)));
  const rows = Math.max(24, Math.min(120, Math.floor((h - CHROME_Y) / CELL_H)));
  return { cols, rows };
}

/** Shared terminal layout constants — keep XTerm.svelte chrome in sync. */
export const TERM_FONT_SIZE = 13;
export const TERM_LINE_HEIGHT = 1.3;

/** FilesPanel 260 + GitPanel 300 */
export const SIDE_PANELS_DESKTOP = 560;

/** Header + .term pad + .xterm pad + border (matches Terminal.svelte + XTerm host). */
export const CHROME_X = 48 + 20 + 24 + 2;
export const CHROME_Y = 110 + 20 + 12 + 2;

/** Approximate cell size for JetBrains Mono 13px / lineHeight 1.3. */
export const CELL_W = 7.8;
export const CELL_H = 17;

export const NARROW_BREAKPOINT = 768;

export function sidePanelsForViewport(width: number): number {
  return width < NARROW_BREAKPOINT ? 0 : SIDE_PANELS_DESKTOP;
}

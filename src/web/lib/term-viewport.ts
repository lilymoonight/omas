import type { Terminal } from '@xterm/xterm';

export type LiveScreenFlags = {
  stickToLiveScreen: boolean;
  pendingScrollBottom: boolean;
  /**
   * True only when the user *intentionally* scrolled up (wheel / keys / drag)
   * to inspect history. Inferred from explicit gestures, never from buffer
   * geometry — a TUI redraw or resize transiently moves viewportY away from
   * baseY, and reading that as "scrolled up" is what made the viewport snap to
   * ancient scrollback at random.
   */
  userScrolledUp: boolean;
};

/** Slack (in rows) when deciding if a gesture left the viewport "at the bottom". */
export const NEAR_BOTTOM_ROWS = 2;

export function isViewportAtBottom(term: Terminal): boolean {
  try {
    const buf = term.buffer.active;
    return buf.viewportY >= buf.baseY;
  } catch {
    return true;
  }
}

/**
 * Tolerant "is the viewport effectively at the bottom" check, used to reset the
 * user-scrolled-up intent once they scroll back down. The slack absorbs the
 * off-by-one drift that xterm leaves after a reflow/resize.
 */
export function isViewportNearBottom(term: Terminal, threshold = NEAR_BOTTOM_ROWS): boolean {
  try {
    const buf = term.buffer.active;
    return buf.baseY - buf.viewportY <= threshold;
  } catch {
    return true;
  }
}

export function isAltScreenActive(term: Terminal): boolean {
  try {
    return term.buffer.active.type === 'alternate';
  } catch {
    return false;
  }
}

/**
 * TUI apps (Cursor/Claude) use the alternate screen (no scrollback), and even
 * plain shells redraw aggressively; a resize or reconnect can leave the
 * viewport showing ancient main-buffer scrollback unless we keep pinning.
 * Stick to the live screen unless the user explicitly scrolled up to read back.
 */
export function shouldStickToLiveScreen(term: Terminal, flags: LiveScreenFlags): boolean {
  if (flags.stickToLiveScreen || flags.pendingScrollBottom) return true;
  if (isAltScreenActive(term)) return true;
  return !flags.userScrolledUp;
}

export function scrollToLiveScreen(term: Terminal): void {
  try {
    term.scrollToBottom();
  } catch {
    /* */
  }
}

export function pinLiveScreen(term: Terminal, flags: LiveScreenFlags): void {
  scrollToLiveScreen(term);
  requestAnimationFrame(() => {
    if (shouldStickToLiveScreen(term, flags)) scrollToLiveScreen(term);
  });
}

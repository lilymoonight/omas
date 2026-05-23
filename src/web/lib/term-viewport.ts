import type { Terminal } from '@xterm/xterm';

export type LiveScreenFlags = {
  stickToLiveScreen: boolean;
  pendingScrollBottom: boolean;
};

export function isViewportAtBottom(term: Terminal): boolean {
  try {
    const buf = term.buffer.active;
    return buf.viewportY >= buf.baseY;
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
 * TUI apps (Cursor/Claude) use the alternate screen; a resize or reconnect can
 * leave the viewport showing ancient main-buffer scrollback unless we keep pinning.
 */
export function shouldStickToLiveScreen(term: Terminal, flags: LiveScreenFlags): boolean {
  if (flags.stickToLiveScreen || flags.pendingScrollBottom) return true;
  if (isAltScreenActive(term)) return true;
  return isViewportAtBottom(term);
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

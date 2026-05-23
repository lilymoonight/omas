import { describe, it, expect, vi } from 'vitest';
import {
  isViewportAtBottom,
  isAltScreenActive,
  shouldStickToLiveScreen,
  pinLiveScreen,
} from '../src/web/lib/term-viewport.js';

function mockTerm(overrides: {
  type?: 'normal' | 'alternate';
  viewportY?: number;
  baseY?: number;
}): { term: import('@xterm/xterm').Terminal; scrollToBottom: ReturnType<typeof vi.fn> } {
  const scrollToBottom = vi.fn();
  const term = {
    buffer: {
      active: {
        type: overrides.type ?? 'normal',
        viewportY: overrides.viewportY ?? 0,
        baseY: overrides.baseY ?? 0,
      },
    },
    scrollToBottom,
  } as unknown as import('@xterm/xterm').Terminal;
  return { term, scrollToBottom };
}

describe('term-viewport', () => {
  it('detects alternate screen', () => {
    const { term } = mockTerm({ type: 'alternate' });
    expect(isAltScreenActive(term)).toBe(true);
  });

  it('sticks on alternate screen even when viewport is not at bottom', () => {
    const { term } = mockTerm({ type: 'alternate', viewportY: 0, baseY: 50 });
    expect(
      shouldStickToLiveScreen(term, { stickToLiveScreen: false, pendingScrollBottom: false }),
    ).toBe(true);
  });

  it('sticks on normal screen only when viewport is at bottom', () => {
    const atBottom = mockTerm({ type: 'normal', viewportY: 10, baseY: 10 });
    const scrolledUp = mockTerm({ type: 'normal', viewportY: 0, baseY: 10 });
    const flags = { stickToLiveScreen: false, pendingScrollBottom: false };
    expect(shouldStickToLiveScreen(atBottom.term, flags)).toBe(true);
    expect(shouldStickToLiveScreen(scrolledUp.term, flags)).toBe(false);
  });

  it('pinLiveScreen scrolls immediately and on next frame when sticking', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const { term, scrollToBottom } = mockTerm({ type: 'alternate', viewportY: 0, baseY: 40 });
    pinLiveScreen(term, { stickToLiveScreen: false, pendingScrollBottom: false });
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('isViewportAtBottom compares viewportY to baseY', () => {
    expect(isViewportAtBottom(mockTerm({ viewportY: 5, baseY: 3 }).term)).toBe(true);
    expect(isViewportAtBottom(mockTerm({ viewportY: 2, baseY: 5 }).term)).toBe(false);
  });
});

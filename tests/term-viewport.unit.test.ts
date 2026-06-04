import { describe, it, expect, vi } from 'vitest';
import {
  gestureScrollIntent,
  isViewportAtBottom,
  isViewportNearBottom,
  isAltScreenActive,
  passiveScrollIntent,
  shouldStickToLiveScreen,
  maybeScrollToLiveScreen,
  pinLiveScreen,
} from '../src/web/lib/term-viewport.js';

const FLAGS = { stickToLiveScreen: false, pendingScrollBottom: false, userScrolledUp: false };

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
    expect(shouldStickToLiveScreen(term, FLAGS)).toBe(true);
  });

  it('does not stick on alternate screen when the user scrolled up into scrollback', () => {
    const { term } = mockTerm({ type: 'alternate', viewportY: 0, baseY: 50 });
    expect(shouldStickToLiveScreen(term, { ...FLAGS, userScrolledUp: true })).toBe(false);
  });

  it('maybeScrollToLiveScreen skips when already at bottom or user scrolled up', () => {
    const atBottom = mockTerm({ type: 'alternate', viewportY: 50, baseY: 50 });
    maybeScrollToLiveScreen(atBottom.term, FLAGS);
    expect(atBottom.scrollToBottom).not.toHaveBeenCalled();

    const scrolledUp = mockTerm({ type: 'alternate', viewportY: 0, baseY: 50 });
    maybeScrollToLiveScreen(scrolledUp.term, { ...FLAGS, userScrolledUp: true });
    expect(scrolledUp.scrollToBottom).not.toHaveBeenCalled();

    const needsPin = mockTerm({ type: 'normal', viewportY: 0, baseY: 50 });
    maybeScrollToLiveScreen(needsPin.term, FLAGS);
    expect(needsPin.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('sticks on normal screen regardless of geometry unless the user scrolled up', () => {
    // The viewport may be far from the bottom mid-reflow; that must NOT stop
    // pinning. Only an explicit user-scrolled-up flag should.
    const reflowing = mockTerm({ type: 'normal', viewportY: 0, baseY: 50 });
    expect(shouldStickToLiveScreen(reflowing.term, FLAGS)).toBe(true);
    expect(
      shouldStickToLiveScreen(reflowing.term, { ...FLAGS, userScrolledUp: true }),
    ).toBe(false);
  });

  it('pinning flags override user-scrolled-up during restore', () => {
    const { term } = mockTerm({ type: 'normal', viewportY: 0, baseY: 50 });
    expect(
      shouldStickToLiveScreen(term, {
        stickToLiveScreen: false,
        pendingScrollBottom: true,
        userScrolledUp: true,
      }),
    ).toBe(true);
  });

  it('pinLiveScreen scrolls immediately and on next frame when sticking', async () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const { term, scrollToBottom } = mockTerm({ type: 'alternate', viewportY: 0, baseY: 40 });
    pinLiveScreen(term, FLAGS);
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('pinLiveScreen force scrolls even when geometry says at bottom', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const { term, scrollToBottom } = mockTerm({ viewportY: 50, baseY: 50 });
    pinLiveScreen(term, FLAGS, { force: true });
    expect(scrollToBottom).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('passiveScrollIntent ignores off-bottom geometry without upward motion', () => {
    const term = mockTerm({ viewportY: 40, baseY: 50 }).term;
    expect(passiveScrollIntent(term, 40, false)).toEqual({ userScrolledUp: false, viewportY: 40 });
    expect(passiveScrollIntent(term, 45, false)).toEqual({ userScrolledUp: true, viewportY: 40 });
  });

  it('passiveScrollIntent clears intent near bottom', () => {
    const term = mockTerm({ viewportY: 49, baseY: 50 }).term;
    expect(passiveScrollIntent(term, 10, true)).toEqual({ userScrolledUp: false, viewportY: 49 });
  });

  it('gestureScrollIntent marks scrolled-up when not near bottom', () => {
    expect(gestureScrollIntent(mockTerm({ viewportY: 10, baseY: 50 }).term)).toBe(true);
    expect(gestureScrollIntent(mockTerm({ viewportY: 49, baseY: 50 }).term)).toBe(false);
  });

  it('isViewportAtBottom compares viewportY to baseY', () => {
    expect(isViewportAtBottom(mockTerm({ viewportY: 5, baseY: 3 }).term)).toBe(true);
    expect(isViewportAtBottom(mockTerm({ viewportY: 2, baseY: 5 }).term)).toBe(false);
  });

  it('isViewportNearBottom tolerates a small gap', () => {
    expect(isViewportNearBottom(mockTerm({ viewportY: 48, baseY: 50 }).term)).toBe(true);
    expect(isViewportNearBottom(mockTerm({ viewportY: 40, baseY: 50 }).term)).toBe(false);
  });
});

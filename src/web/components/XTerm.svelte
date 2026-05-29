<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { WebglAddon } from '@xterm/addon-webgl';
  import { ClipboardAddon } from '@xterm/addon-clipboard';
  import { SessionSocket } from '../lib/ws.js';
  import { canSyncTermSize, type AttachPhase } from '../lib/attach-sync.js';
  import { TERM_FONT_SIZE, TERM_LINE_HEIGHT } from '../lib/term-layout.js';
  import {
    isViewportNearBottom,
    pinLiveScreen,
    scrollToLiveScreen,
    shouldStickToLiveScreen,
  } from '../lib/term-viewport.js';
  import { createTermWriteBatch, type TermWriteBatch } from '../lib/term-write-batch.js';
  import '@xterm/xterm/css/xterm.css';

  interface Props {
    sessionId: string;
    onTitle?: (title: string) => void;
    onClientCount?: (n: number) => void;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
    onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
  }
  const { sessionId, onTitle, onClientCount, onExit, onStatus }: Props = $props();

  let host: HTMLDivElement;
  let term: Terminal;
  let fit: FitAddon;
  let socket: SessionSocket;
  let writeBatch: TermWriteBatch | undefined;
  let resizeObserver: ResizeObserver;
  let resizeRaf: number | undefined;
  let syncDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  /** After a full snapshot restore, scroll to the live screen once writes land. */
  let pendingScrollBottom = false;
  let restoreScrollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Keep viewport on the live screen through fit/resize during attach settle. */
  let stickToLiveScreen = false;
  /**
   * Set only when the user actively scrolls up to read history; cleared when
   * they scroll back to (near) the bottom. Driven by real gestures so TUI
   * redraws / resizes can't be misread as "scrolled up".
   */
  let userScrolledUp = false;
  /** Re-evaluate scroll intent after a user gesture settles. */
  let scrollIntentRaf: number | undefined;
  /** First attach settle (fonts + delayed fit) runs once per mount. */
  let attachSettled = false;
  /** Ignore fit/resize echoes while applying server snapshot dimensions. */
  let suppressResizeNotify = false;
  /** Block server resize until hello (and snapshot restore, if any) completes. */
  let attachPhase: AttachPhase = 'connecting';

  function canSyncSize(): boolean {
    return canSyncTermSize(attachPhase);
  }

  function liveFlags() {
    return { stickToLiveScreen, pendingScrollBottom, userScrolledUp };
  }

  /**
   * Recompute scroll intent from the *current* viewport after a user gesture.
   * The alt screen has no scrollback, so intent only applies to the normal
   * buffer; there we treat "near the bottom" as still pinned to live.
   */
  function refreshScrollIntent(): void {
    if (scrollIntentRaf !== undefined) cancelAnimationFrame(scrollIntentRaf);
    scrollIntentRaf = requestAnimationFrame(() => {
      scrollIntentRaf = undefined;
      if (pendingScrollBottom) return;
      userScrolledUp = !isViewportNearBottom(term);
    });
  }

  function pinLive() {
    pinLiveScreen(term, liveFlags());
  }

  function finishRestoreScroll(): void {
    pendingScrollBottom = false;
    if (restoreScrollTimer !== undefined) {
      clearTimeout(restoreScrollTimer);
      restoreScrollTimer = undefined;
    }
    pinLive();
  }

  function scheduleRestoreScrollFallback(): void {
    if (restoreScrollTimer !== undefined) clearTimeout(restoreScrollTimer);
    // Fallback if xterm write() callback fires before a large snapshot finishes parsing.
    restoreScrollTimer = setTimeout(() => {
      if (pendingScrollBottom) finishRestoreScroll();
    }, 150);
  }

  function currentSize(): { cols: number; rows: number } {
    try {
      const proposed = fit.proposeDimensions();
      if (proposed && proposed.cols && proposed.rows) return proposed;
    } catch {
      /* container hidden */
    }
    return { cols: 80, rows: 24 };
  }

  function applyTermSize(cols: number, rows: number): void {
    if (term.cols === cols && term.rows === rows) return;
    suppressResizeNotify = true;
    try {
      term.resize(cols, rows);
    } finally {
      suppressResizeNotify = false;
    }
  }

  function fitToHost(): void {
    suppressResizeNotify = true;
    try {
      fit.fit();
      const { cols, rows } = currentSize();
      if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
    } finally {
      suppressResizeNotify = false;
    }
  }

  function syncSizeToServer(): void {
    if (!canSyncSize()) return;
    const flags = liveFlags();
    const pin = shouldStickToLiveScreen(term, flags);
    try {
      const prevCols = term.cols;
      const prevRows = term.rows;
      fitToHost();
      const resized = term.cols !== prevCols || term.rows !== prevRows;
      if (resized) {
        socket?.send({ type: 'resize', cols: term.cols, rows: term.rows });
      }
      if (resized || pin) pinLive();
    } catch { /* hidden */ }
  }

  function scheduleSyncSizeToServer(): void {
    if (!canSyncSize()) return;
    if (syncDebounceTimer !== undefined) clearTimeout(syncDebounceTimer);
    syncDebounceTimer = setTimeout(() => {
      syncDebounceTimer = undefined;
      syncSizeToServer();
    }, 100);
  }

  function scheduleLayoutSettleSync(): void {
    for (const ms of [80, 300]) {
      setTimeout(() => {
        if (canSyncSize()) syncSizeToServer();
      }, ms);
    }
  }

  function markAttachReady(): void {
    attachPhase = 'ready';
    syncSizeToServer();
    if (attachSettled) return;
    attachSettled = true;
    scheduleLayoutSettleSync();
    void document.fonts.ready.then(() => {
      if (!canSyncSize()) return;
      syncSizeToServer();
      stickToLiveScreen = false;
      pinLive();
    });
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: '"JetBrains Mono","Fira Code","SF Mono",Menlo,Monaco,Consolas,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",monospace',
      fontSize: TERM_FONT_SIZE,
      lineHeight: TERM_LINE_HEIGHT,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      // Bright theme — based on GitHub Light, tuned for legibility.
      theme: {
        background:    '#ffffff',
        foreground:    '#1f2328',
        cursor:        '#2f6feb',
        cursorAccent:  '#ffffff',
        selectionBackground: '#cce2ff',
        selectionForeground: '#1f2328',
        black:         '#24292f',
        red:           '#cf222e',
        green:         '#116329',
        yellow:        '#9a6700',
        blue:          '#0969da',
        magenta:       '#8250df',
        cyan:          '#1b7c83',
        white:         '#6e7781',
        brightBlack:   '#57606a',
        brightRed:     '#a40e26',
        brightGreen:   '#1a7f37',
        brightYellow:  '#7d4e00',
        brightBlue:    '#218bff',
        brightMagenta: '#a475f9',
        brightCyan:    '#3192aa',
        brightWhite:   '#1f2328',
      },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch (err) {
      console.warn('WebGL renderer unavailable, falling back to canvas', err);
    }
    // Do not fit before hello — mount-time fit + onResize would resize the server
    // before the snapshot lands, desyncing PTY cols from the serialized screen.

    writeBatch = createTermWriteBatch((data, cb) => term.write(data, cb));

    socket = new SessionSocket(sessionId);
    socket.on('status', (s) => onStatus?.(s));
    socket.on('hello', (msg) => {
      if (msg.truncated) {
        attachPhase = 'restoring';
        stickToLiveScreen = true;
        // Full snapshot restore wipes the old viewport position; start pinned.
        userScrolledUp = false;
        term.clear();
        // Snapshot bytes were serialized at msg.cols × msg.rows. Resizing the
        // server (or client fit) before they land desyncs TUI layout → bad wrap
        // and viewport stuck at scrollback top.
        applyTermSize(msg.cols, msg.rows);
        pendingScrollBottom = true;
        scheduleRestoreScrollFallback();
      } else if (attachPhase !== 'ready') {
        markAttachReady();
      } else {
        // Soft reconnect: screen state is intact; avoid re-running attach settle.
        syncSizeToServer();
      }
      onClientCount?.(msg.clientCount);
    });
    socket.on('data', (bytes) => {
      const onDone = () => {
        if (pendingScrollBottom) {
          finishRestoreScroll();
          requestAnimationFrame(() => markAttachReady());
        } else if (shouldStickToLiveScreen(term, liveFlags())) {
          // Re-check intent *after* the write lands: the data may have flipped
          // to the alt screen or pushed new live output. Pinning here is what
          // keeps a redrawing TUI from drifting up into old scrollback.
          scrollToLiveScreen(term);
        }
      };
      if (pendingScrollBottom) {
        writeBatch?.flush();
        term.write(bytes, onDone);
        return;
      }
      writeBatch?.push(bytes, onDone);
    });
    socket.on('title', (t) => onTitle?.(t));
    socket.on('clients', (c) => onClientCount?.(c));
    socket.on('exit', (info) => onExit?.(info));

    term.onData((data) => socket.send({ type: 'input', data }));
    term.onResize(({ cols, rows }) => {
      if (!canSyncSize() || suppressResizeNotify) return;
      socket.send({ type: 'resize', cols, rows });
    });
    term.onTitleChange((t) => {
      // The shell can set its own title via OSC 0; mirror it to the server for the list view.
      socket.send({ type: 'title', title: t });
    });

    resizeObserver = new ResizeObserver(() => {
      if (!canSyncSize()) return;
      if (resizeRaf !== undefined) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = undefined;
        scheduleSyncSizeToServer();
      });
    });
    resizeObserver.observe(host);

    // Scroll intent comes from real user gestures only — never from buffer
    // geometry. A resize/reflow or TUI redraw transiently moves viewportY, and
    // reading that as "scrolled up" is exactly what snapped the viewport to old
    // scrollback at random. Wheel + scroll keys cover scrolling up and back.
    host.addEventListener('wheel', refreshScrollIntent, { passive: true });
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && (e.key === 'PageUp' || e.key === 'PageDown'
        || (e.shiftKey && (e.key === 'Home' || e.key === 'End')))) {
        refreshScrollIntent();
      }
      return true;
    });

    socket.connect();
    setTimeout(() => term.focus(), 0);
  });

  onDestroy(() => {
    writeBatch?.flush();
    writeBatch?.dispose();
    if (restoreScrollTimer !== undefined) clearTimeout(restoreScrollTimer);
    if (syncDebounceTimer !== undefined) clearTimeout(syncDebounceTimer);
    if (resizeRaf !== undefined) cancelAnimationFrame(resizeRaf);
    if (scrollIntentRaf !== undefined) cancelAnimationFrame(scrollIntentRaf);
    host?.removeEventListener('wheel', refreshScrollIntent);
    resizeObserver?.disconnect();
    socket?.close();
    term?.dispose();
  });
</script>

<div class="xterm-host" bind:this={host}></div>

<style>
  /* Host is intentionally bare — no padding, no border, no margin.
     FitAddon divides clientHeight by cell height and floors; any extra
     padding here makes the last row come out half-shown. Put the visual
     chrome (border, padding-around, shadow) on the parent in Terminal.svelte. */
  .xterm-host {
    width: 100%;
    height: 100%;
    padding: 0;
    margin: 0;
    box-sizing: border-box;
    overflow: hidden;
  }
  :global(.xterm-viewport) {
    background-color: transparent !important;
  }
</style>

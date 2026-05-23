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
  let resizeObserver: ResizeObserver;
  /** After a full snapshot restore, scroll to the live screen once writes land. */
  let pendingScrollBottom = false;
  let restoreScrollTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ignore fit/resize echoes while applying server snapshot dimensions. */
  let suppressResizeNotify = false;
  /** Block server resize until hello (and snapshot restore, if any) completes. */
  let attachPhase: AttachPhase = 'connecting';

  function canSyncSize(): boolean {
    return canSyncTermSize(attachPhase);
  }

  function isViewportAtBottom(): boolean {
    try {
      const buf = term.buffer.active;
      return buf.viewportY >= buf.baseY;
    } catch {
      return true;
    }
  }

  function scrollToLiveScreen(): void {
    try { term.scrollToBottom(); } catch { /* */ }
  }

  function finishRestoreScroll(): void {
    pendingScrollBottom = false;
    if (restoreScrollTimer !== undefined) {
      clearTimeout(restoreScrollTimer);
      restoreScrollTimer = undefined;
    }
    scrollToLiveScreen();
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

  function syncSizeToServer(): void {
    if (!canSyncSize()) return;
    try {
      fit.fit();
      const { cols, rows } = currentSize();
      if (cols !== term.cols || rows !== term.rows) applyTermSize(cols, rows);
      socket?.send({ type: 'resize', cols: term.cols, rows: term.rows });
    } catch { /* hidden */ }
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
    scheduleLayoutSettleSync();
    void document.fonts.ready.then(() => {
      if (canSyncSize()) syncSizeToServer();
    });
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: '"JetBrains Mono","Fira Code","SF Mono",Menlo,Monaco,Consolas,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",monospace',
      fontSize: TERM_FONT_SIZE,
      lineHeight: TERM_LINE_HEIGHT,
      cursorBlink: true,
      scrollback: 10000,
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

    socket = new SessionSocket(sessionId);
    socket.on('status', (s) => onStatus?.(s));
    socket.on('hello', (msg) => {
      if (msg.truncated) {
        attachPhase = 'restoring';
        term.clear();
        // Snapshot bytes were serialized at msg.cols × msg.rows. Resizing the
        // server (or client fit) before they land desyncs TUI layout → bad wrap
        // and viewport stuck at scrollback top.
        applyTermSize(msg.cols, msg.rows);
        pendingScrollBottom = true;
        scheduleRestoreScrollFallback();
      } else {
        markAttachReady();
      }
      onClientCount?.(msg.clientCount);
    });
    socket.on('data', (bytes) => {
      const stick = !pendingScrollBottom && isViewportAtBottom();
      term.write(bytes, () => {
        if (pendingScrollBottom) {
          finishRestoreScroll();
          requestAnimationFrame(() => markAttachReady());
        } else if (stick) {
          scrollToLiveScreen();
        }
      });
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
      syncSizeToServer();
    });
    resizeObserver.observe(host);

    socket.connect();
    setTimeout(() => term.focus(), 0);
  });

  onDestroy(() => {
    if (restoreScrollTimer !== undefined) clearTimeout(restoreScrollTimer);
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

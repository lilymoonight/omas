<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { WebglAddon } from '@xterm/addon-webgl';
  import { ClipboardAddon } from '@xterm/addon-clipboard';
  import { SessionSocket } from '../lib/ws.js';
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
  /** After a full snapshot restore, xterm viewport stays at scrollback top unless we scroll down. */
  let pendingScrollBottom = false;

  function currentSize(): { cols: number; rows: number } {
    try {
      const proposed = fit.proposeDimensions();
      if (proposed && proposed.cols && proposed.rows) return proposed;
    } catch {
      /* container hidden */
    }
    return { cols: 80, rows: 24 };
  }

  function syncSizeToServer(): void {
    try {
      fit.fit();
      const { cols, rows } = currentSize();
      socket?.send({ type: 'resize', cols, rows });
    } catch { /* hidden */ }
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: '"JetBrains Mono","Fira Code","SF Mono",Menlo,Monaco,Consolas,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",monospace',
      fontSize: 13,
      lineHeight: 1.3,
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
    // Fit several times: now, next paint, and after layout has settled. This
    // covers the case where the surrounding flex layout finalizes after mount,
    // which otherwise leaves the terminal undersized and the last row clipped.
    const tryFit = () => { try { fit.fit(); } catch { /* */ } };
    tryFit();
    requestAnimationFrame(tryFit);
    setTimeout(tryFit, 80);
    setTimeout(tryFit, 300);

    socket = new SessionSocket(sessionId);
    socket.on('status', (s) => onStatus?.(s));
    socket.on('hello', (msg) => {
      // Server-truncated → start from a clean screen.
      if (msg.truncated) {
        term.clear();
        pendingScrollBottom = true;
        // Empty snapshot: still ensure viewport at live screen, not scrollback top.
        requestAnimationFrame(() => {
          if (pendingScrollBottom) {
            pendingScrollBottom = false;
            try { term.scrollToBottom(); } catch { /* */ }
          }
        });
      }
      syncSizeToServer();
      onClientCount?.(msg.clientCount);
    });
    socket.on('data', (bytes) => {
      term.write(bytes, () => {
        if (!pendingScrollBottom) return;
        pendingScrollBottom = false;
        try { term.scrollToBottom(); } catch { /* */ }
      });
    });
    socket.on('title', (t) => onTitle?.(t));
    socket.on('clients', (c) => onClientCount?.(c));
    socket.on('exit', (info) => onExit?.(info));

    term.onData((data) => socket.send({ type: 'input', data }));
    term.onResize(({ cols, rows }) => socket.send({ type: 'resize', cols, rows }));
    term.onTitleChange((t) => {
      // The shell can set its own title via OSC 0; mirror it to the server for the list view.
      socket.send({ type: 'title', title: t });
    });

    resizeObserver = new ResizeObserver(() => {
      syncSizeToServer();
    });
    resizeObserver.observe(host);

    // Fit before connecting so the PTY gets a realistic width before the user runs TUI apps.
    syncSizeToServer();
    socket.connect();
    setTimeout(() => term.focus(), 0);
  });

  onDestroy(() => {
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

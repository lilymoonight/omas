<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import { WebglAddon } from '@xterm/addon-webgl';
  import { ClipboardAddon } from '@xterm/addon-clipboard';
  import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
  import { SerializeAddon } from '@xterm/addon-serialize';
  import Icon from './Icon.svelte';
  import { SessionSocket } from '../lib/ws.js';
  import { downloadBlob, fileStamp, safeFileLabel } from '../lib/download.js';
  import { canSyncTermSize, type AttachPhase } from '../lib/attach-sync.js';
  import { TERM_FONT_SIZE, TERM_LINE_HEIGHT } from '../lib/term-layout.js';
  import {
    isViewportNearBottom,
    pinLiveScreen,
    scrollToLiveScreen,
    shouldStickToLiveScreen,
  } from '../lib/term-viewport.js';
  import { createTermWriteBatch, type TermWriteBatch } from '../lib/term-write-batch.js';
  import { resolvedTheme, type ResolvedTheme } from '../lib/theme.js';
  import '@xterm/xterm/css/xterm.css';

  // xterm palettes per UI theme. Light is GitHub Light; dark is GitHub Dark.
  const LIGHT_TERM_THEME = {
    background: '#ffffff',
    foreground: '#1f2328',
    cursor: '#2f6feb',
    cursorAccent: '#ffffff',
    selectionBackground: '#cce2ff',
    selectionForeground: '#1f2328',
    black: '#24292f',
    red: '#cf222e',
    green: '#116329',
    yellow: '#9a6700',
    blue: '#0969da',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#a40e26',
    brightGreen: '#1a7f37',
    brightYellow: '#7d4e00',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#1f2328',
  };
  const DARK_TERM_THEME = {
    background: '#0e1116',
    foreground: '#e6edf3',
    cursor: '#58a6ff',
    cursorAccent: '#0e1116',
    selectionBackground: '#2d4a73',
    selectionForeground: '#e6edf3',
    black: '#484f58',
    red: '#ff7b72',
    green: '#3fb950',
    yellow: '#d29922',
    blue: '#58a6ff',
    magenta: '#bc8cff',
    cyan: '#39c5cf',
    white: '#b1bac4',
    brightBlack: '#6e7681',
    brightRed: '#ffa198',
    brightGreen: '#56d364',
    brightYellow: '#e3b341',
    brightBlue: '#79c0ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#56d4dd',
    brightWhite: '#f0f6fc',
  };
  const termTheme = (t: ResolvedTheme) => (t === 'dark' ? DARK_TERM_THEME : LIGHT_TERM_THEME);

  // Search-match highlight colors, picked to read well against each terminal palette.
  const searchDecorations = (t: ResolvedTheme) =>
    t === 'dark'
      ? { matchBackground: '#574a1f', activeMatchBackground: '#bb8009', matchOverviewRuler: '#d29922', activeMatchColorOverviewRuler: '#e3b341' }
      : { matchBackground: '#fff1b8', activeMatchBackground: '#f7c948', matchOverviewRuler: '#9a6700', activeMatchColorOverviewRuler: '#9a6700' };

  interface Props {
    sessionId: string;
    /** When set, attach over the read-only share token instead of the session id. */
    shareToken?: string;
    title?: string;
    onTitle?: (title: string) => void;
    onClientCount?: (n: number) => void;
    onExit?: (info: { code: number | null; signal: string | null }) => void;
    onStatus?: (status: 'connecting' | 'open' | 'closed') => void;
    onRecordingChange?: (recording: boolean) => void;
    /** Click handler for file-path-looking tokens in the output (disabled for share viewers). */
    onOpenPath?: (raw: string) => void;
  }
  const {
    sessionId,
    shareToken,
    title = '终端',
    onTitle,
    onClientCount,
    onExit,
    onStatus,
    onRecordingChange,
    onOpenPath,
  }: Props = $props();

  // Path-like tokens: anything with a slash, or a bare name with a file
  // extension, optionally followed by a :line[:col] suffix (compiler/grep style).
  const PATH_RE =
    /(?:(?:~\/|\.{1,2}\/|\/)?[\w.+@-]+(?:\/[\w.+@-]+)+|[\w.+@-]+\.[A-Za-z][A-Za-z0-9]{0,9})(?::\d+(?::\d+)?)?/g;

  let host: HTMLDivElement;
  let term: Terminal;
  let unsubTheme: (() => void) | undefined;
  let fit: FitAddon;
  let search: SearchAddon;
  let serialize: SerializeAddon;
  let socket: SessionSocket;

  // asciinema recording: capture decoded PTY output with relative timestamps,
  // seeded with a snapshot of the current screen so playback starts in context.
  let recording = false;
  let recStart = 0;
  let recEvents: Array<[number, 'o', string]> = [];
  let recDecoder: TextDecoder | null = null;
  let recCols = 80;
  let recRows = 24;

  // Scrollback search (Cmd/Ctrl+F). Highlights matches and lets the user step
  // through them while an agent's long output sits in scrollback.
  let searchInput = $state<HTMLInputElement | null>(null);
  let searchOpen = $state(false);
  let searchTerm = $state('');
  let searchCase = $state(false);
  let searchRegex = $state(false);
  let matchIndex = $state(0);
  let matchTotal = $state(0);
  let currentTheme: ResolvedTheme = 'light';
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
    // A read-only viewer must never resize/reflow: it keeps the session's native
    // cols×rows so the layout matches what the owner sees (no fitting to the
    // viewer's own window, which would rewrap lines and break TUI alignment).
    if (shareToken) return false;
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

  function exportBaseName(): string {
    return `${safeFileLabel(title)}_${fileStamp()}`;
  }

  function recordChunk(bytes: Uint8Array): void {
    if (!recDecoder) return;
    const t = (performance.now() - recStart) / 1000;
    const text = recDecoder.decode(bytes, { stream: true });
    if (text) recEvents.push([t, 'o', text]);
  }

  export function isRecording(): boolean {
    return recording;
  }

  /** Begin an asciinema (cast v2) recording, seeded with the current screen. */
  export function startRecording(): void {
    if (recording || !term) return;
    recording = true;
    recStart = performance.now();
    recCols = term.cols;
    recRows = term.rows;
    recDecoder = new TextDecoder('utf-8');
    recEvents = [];
    // Seed with a snapshot so the cast opens on the current screen, not a blank one.
    try {
      const snap = serialize?.serialize();
      if (snap) recEvents.push([0, 'o', snap]);
    } catch { /* ignore */ }
    onRecordingChange?.(true);
  }

  export function stopRecording(): void {
    if (!recording) return;
    recording = false;
    onRecordingChange?.(false);
    // Flush any pending multibyte tail from the streaming decoder.
    const tail = recDecoder?.decode();
    if (tail) recEvents.push([(performance.now() - recStart) / 1000, 'o', tail]);
    recDecoder = null;
    const header = {
      version: 2,
      width: recCols,
      height: recRows,
      timestamp: Math.floor(Date.now() / 1000),
      title,
      env: { TERM: 'xterm-256color' },
    };
    const lines = [JSON.stringify(header), ...recEvents.map((e) => JSON.stringify(e))];
    recEvents = [];
    downloadBlob(`${exportBaseName()}.cast`, new Blob([lines.join('\n') + '\n'], { type: 'application/x-asciicast' }));
  }

  export function toggleRecording(): void {
    if (recording) stopRecording();
    else startRecording();
  }

  /**
   * Register a link provider that turns file-path-looking tokens into clickable
   * links. We only handle the single (unwrapped) buffer line, mapping string
   * indices straight to columns — exact for ASCII paths, which is the common case.
   */
  function registerPathLinks(): void {
    term.registerLinkProvider({
      provideLinks(y, callback) {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) return callback(undefined);
        const text = line.translateToString(false);
        const links = [] as Array<{
          range: { start: { x: number; y: number }; end: { x: number; y: number } };
          text: string;
          activate: (e: MouseEvent, t: string) => void;
        }>;
        PATH_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PATH_RE.exec(text))) {
          const matched = m[0];
          if (/^https?:\/\//i.test(matched)) continue; // urls handled by WebLinksAddon
          const startX = m.index;
          links.push({
            range: { start: { x: startX + 1, y }, end: { x: startX + matched.length, y } },
            text: matched,
            activate: (_e, t) => onOpenPath?.(t),
          });
        }
        callback(links.length ? links : undefined);
      },
    });
  }

  function searchOptions(): ISearchOptions {
    return {
      caseSensitive: searchCase,
      regex: searchRegex,
      decorations: searchDecorations(currentTheme),
    };
  }

  function runSearch(direction: 'next' | 'prev' = 'next'): void {
    if (!search) return;
    const q = searchTerm;
    if (!q) {
      search.clearDecorations();
      matchIndex = 0;
      matchTotal = 0;
      return;
    }
    if (direction === 'prev') search.findPrevious(q, searchOptions());
    else search.findNext(q, searchOptions());
  }

  function openSearch(): void {
    searchOpen = true;
    // Reading scrollback — don't let live output yank the viewport to the bottom.
    userScrolledUp = true;
    const sel = term?.getSelection();
    if (sel && !sel.includes('\n') && sel.length <= 200) searchTerm = sel;
    requestAnimationFrame(() => {
      searchInput?.focus();
      searchInput?.select();
      if (searchTerm) runSearch('next');
    });
  }

  function closeSearch(): void {
    searchOpen = false;
    search?.clearDecorations();
    matchIndex = 0;
    matchTotal = 0;
    term?.focus();
    // Re-evaluate whether we're back at the live screen.
    refreshScrollIntent();
  }

  function toggleSearch(): void {
    if (searchOpen) closeSearch();
    else openSearch();
  }

  function onSearchKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch(e.shiftKey ? 'prev' : 'next');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  }

  onMount(() => {
    // Track current theme; the subscription fires synchronously here, so
    // `current` is set before the Terminal is constructed, and later toggles
    // update the live terminal palette.
    let current: ResolvedTheme = 'light';
    unsubTheme = resolvedTheme.subscribe((t) => {
      current = t;
      currentTheme = t;
      if (term) {
        term.options.theme = termTheme(t);
        // Re-highlight with palette-matched colors after a theme flip.
        if (searchOpen && searchTerm) runSearch('next');
      }
    });

    term = new Terminal({
      fontFamily: '"JetBrains Mono","Fira Code","SF Mono",Menlo,Monaco,Consolas,"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC",monospace',
      fontSize: TERM_FONT_SIZE,
      lineHeight: TERM_LINE_HEIGHT,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: termTheme(current),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    if (onOpenPath) registerPathLinks();
    term.loadAddon(new ClipboardAddon());
    search = new SearchAddon();
    term.loadAddon(search);
    serialize = new SerializeAddon();
    term.loadAddon(serialize);
    search.onDidChangeResults(({ resultIndex, resultCount }) => {
      matchTotal = resultCount;
      matchIndex = resultCount > 0 ? resultIndex + 1 : 0;
    });
    term.open(host);
    try {
      term.loadAddon(new WebglAddon());
    } catch (err) {
      console.warn('WebGL renderer unavailable, falling back to canvas', err);
    }
    // Do not fit before hello — mount-time fit + onResize would resize the server
    // before the snapshot lands, desyncing PTY cols from the serialized screen.

    writeBatch = createTermWriteBatch((data, cb) => term.write(data, cb));

    socket = new SessionSocket(sessionId, shareToken ? { shareToken } : {});
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
      if (recording) recordChunk(bytes);
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

    // A read-only viewer never drives the PTY: no input, no resize, no title push.
    if (!shareToken) {
      term.onData((data) => socket.send({ type: 'input', data }));
      term.onResize(({ cols, rows }) => {
        if (!canSyncSize() || suppressResizeNotify) return;
        socket.send({ type: 'resize', cols, rows });
      });
      term.onTitleChange((t) => {
        // The shell can set its own title via OSC 0; mirror it to the server for the list view.
        socket.send({ type: 'title', title: t });
      });
    }

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
      // Cmd/Ctrl+F opens scrollback search instead of the browser's find — but
      // only on the normal buffer. On the alt screen a full-screen TUI (vim,
      // cursor-agent/claude TUI) owns Ctrl+F, and there's no scrollback to search.
      if (
        e.type === 'keydown'
        && (e.metaKey || e.ctrlKey)
        && !e.altKey
        && (e.key === 'f' || e.key === 'F')
        && (e.metaKey || term.buffer.active.type === 'normal')
      ) {
        e.preventDefault();
        openSearch();
        return false;
      }
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
    unsubTheme?.();
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

<div class="xterm-shell">
  <div class="xterm-host" bind:this={host}></div>

  {#if searchOpen}
    <div class="search-bar" role="search">
      <span class="search-icon"><Icon name="search" size={14} /></span>
      <input
        class="search-field"
        type="text"
        placeholder="搜索输出…"
        spellcheck="false"
        autocomplete="off"
        bind:this={searchInput}
        bind:value={searchTerm}
        oninput={() => runSearch('next')}
        onkeydown={onSearchKeydown}
      />
      <span class="search-count" class:empty={searchTerm && matchTotal === 0}>
        {#if searchTerm}{matchIndex}/{matchTotal}{:else}—{/if}
      </span>
      <button
        class="search-toggle"
        class:on={searchCase}
        title="区分大小写"
        aria-label="区分大小写"
        aria-pressed={searchCase}
        onclick={() => { searchCase = !searchCase; runSearch('next'); }}
      >Aa</button>
      <button
        class="search-toggle"
        class:on={searchRegex}
        title="正则表达式"
        aria-label="正则表达式"
        aria-pressed={searchRegex}
        onclick={() => { searchRegex = !searchRegex; runSearch('next'); }}
      >.*</button>
      <button class="search-btn" title="上一个（Shift+Enter）" aria-label="上一个匹配" onclick={() => runSearch('prev')}>
        <Icon name="arrow-up" size={14} />
      </button>
      <button class="search-btn" title="下一个（Enter）" aria-label="下一个匹配" onclick={() => runSearch('next')}>
        <Icon name="arrow-down" size={14} />
      </button>
      <button class="search-btn" title="关闭（Esc）" aria-label="关闭搜索" onclick={closeSearch}>
        <Icon name="x" size={14} />
      </button>
    </div>
  {/if}
</div>

<style>
  /* Shell wraps the bare terminal host plus the floating search bar so the bar
     can position relative to the terminal without disturbing FitAddon's sizing. */
  .xterm-shell {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
  }
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

  .search-bar {
    position: absolute;
    top: 10px;
    right: 16px;
    z-index: 25;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 6px 5px 10px;
    background: var(--bg-elev);
    border: 1px solid var(--border-strong, var(--border));
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
  }
  .search-icon { display: inline-flex; color: var(--fg-muted); flex-shrink: 0; }
  .search-field {
    width: 200px;
    max-width: 40vw;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 13px;
    padding: 2px 2px;
    outline: none;
  }
  .search-field::placeholder { color: var(--fg-muted); }
  .search-count {
    font-size: 11.5px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
    min-width: 34px;
    text-align: right;
    padding: 0 2px;
    white-space: nowrap;
  }
  .search-count.empty { color: var(--danger); }
  .search-toggle {
    flex-shrink: 0;
    min-width: 24px;
    height: 24px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 5px;
    background: transparent;
    color: var(--fg-muted);
    font-size: 11.5px;
    font-weight: 600;
    font-family: var(--mono, monospace);
    cursor: pointer;
    line-height: 1;
  }
  .search-toggle:hover { background: var(--bg-hover); color: var(--fg); }
  .search-toggle.on {
    background: var(--accent-soft);
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .search-btn {
    flex-shrink: 0;
    width: 26px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .search-btn:hover { background: var(--bg-hover); color: var(--fg); }
</style>

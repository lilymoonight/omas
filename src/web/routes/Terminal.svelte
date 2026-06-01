<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import XTerm from '../components/XTerm.svelte';
  import FilesPanel from '../components/FilesPanel.svelte';
  import GitPanel from '../components/GitPanel.svelte';
  import { api } from '../lib/api.js';
  import { themePref, cycleTheme, THEME_LABEL } from '../lib/theme.js';
  import { refreshHistoryAfterSessionClose } from '../lib/history-cache.js';
  import { navigate } from '../lib/router.js';
  import { estimateTermSize } from '../lib/term-size.js';
  import { NARROW_BREAKPOINT } from '../lib/term-layout.js';
  import type { Session } from '../../shared/session.js';
  import type { Component } from 'svelte';
  import Icon from '../components/Icon.svelte';

  interface Props { sessionId: string; }
  const { sessionId }: Props = $props();

  let EditorModal = $state<Component<{
    sessionId: string;
    path: string;
    root: string;
    onClose: () => void;
    onSaved?: () => void;
  }> | null>(null);
  let editingPath = $state<string | null>(null);
  let editingRoot = $state('');

  async function openTerminalPath(raw: string) {
    // Drop any :line[:col] suffix; we only open the file, not a position.
    const p = raw.replace(/:(\d+)(?::\d+)?$/, '');
    if (!p || p.startsWith('~')) return; // can't resolve $HOME on the client
    let cwd = '';
    try {
      cwd = (await api.fsCwd(sessionId)).cwd;
    } catch {
      cwd = (session?.liveCwd || session?.cwd || '') as string;
    }
    if (!cwd) return;
    const cwdNorm = cwd.replace(/\/+$/, '');
    let rel: string;
    if (p.startsWith('/')) {
      if (p === cwdNorm) return;
      if (p.startsWith(cwdNorm + '/')) rel = p.slice(cwdNorm.length + 1);
      else {
        alert('该路径不在会话工作目录内，无法在网页打开。');
        return;
      }
    } else {
      rel = p.replace(/^\.\//, '');
    }
    if (!rel) return;
    if (!EditorModal) EditorModal = (await import('../components/FileEditorModal.svelte')).default;
    editingRoot = cwd;
    editingPath = rel;
  }

  let session = $state<Session | null>(null);
  let status = $state<'connecting' | 'open' | 'closed'>('connecting');
  let clientCount = $state(1);
  let exitInfo = $state<{ code: number | null; signal: string | null } | null>(null);
  let notFound = $state(false);
  let title = $state<string>('终端');
  let isNarrow = $state(false);
  let drawerLeft = $state(false);
  let drawerRight = $state(false);

  let filesPanel = $state<{ refresh: () => void } | null>(null);
  let xterm = $state<{
    toggleRecording: () => void;
    isRecording: () => boolean;
  } | null>(null);

  let menuOpen = $state(false);
  let recording = $state(false);
  let shareToken = $state<string | null>(null);
  let shareBusy = $state(false);
  let shareCopied = $state(false);

  function shareUrl(token: string): string {
    return `${location.origin}${location.pathname}${location.search}#/shared/${token}`;
  }

  async function shareSession() {
    shareBusy = true;
    try {
      const { token } = await api.createShare(sessionId);
      shareToken = token;
      try {
        await navigator.clipboard.writeText(shareUrl(token));
        shareCopied = true;
        setTimeout(() => (shareCopied = false), 1600);
      } catch { /* clipboard blocked — link is still visible in the menu */ }
    } catch (e) {
      alert(`创建分享链接失败：${e}`);
    } finally {
      shareBusy = false;
    }
  }

  async function revokeShare() {
    try {
      await api.revokeShare(sessionId);
      shareToken = null;
    } catch (e) {
      alert(`撤销失败：${e}`);
    }
  }

  function exportAs(kind: 'txt' | 'html' | 'cast') {
    menuOpen = false;
    if (kind === 'cast') {
      xterm?.toggleRecording();
      return;
    }
    // Server export pulls the full headless mirror (screen + scrollback), so it
    // includes history rather than just the client's current screen.
    const a = document.createElement('a');
    a.href = api.sessionExportUrl(sessionId, kind);
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  type UploadItem = {
    id: number;
    name: string;
    loaded: number;
    total: number;
    status: 'uploading' | 'done' | 'error';
    error?: string;
  };
  let uploads = $state<UploadItem[]>([]);
  let dragDepth = $state(0);
  let uploadSeq = 0;
  const dragging = $derived(dragDepth > 0);
  const dropTarget = $derived(session?.liveCwd || session?.cwd || '');

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function dragHasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
  }

  function onDragEnter(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth += 1;
  }
  function onDragOver(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }
  function onDragLeave(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
  }
  function onDrop(e: DragEvent): void {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    const files = e.dataTransfer?.files;
    if (files && files.length) void uploadFiles(Array.from(files));
  }

  async function uploadFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const item: UploadItem = {
        id: ++uploadSeq,
        name: file.name,
        loaded: 0,
        total: file.size,
        status: 'uploading',
      };
      uploads = [...uploads, item];
      // XHR `progress` can fire dozens of times/sec; rebuilding the whole
      // uploads array each time is wasteful. Throttle to ~10 fps, but always
      // flush the final (loaded === total) tick.
      let lastTick = 0;
      try {
        await api.fsUpload(sessionId, file, {
          onProgress: (loaded, total) => {
            const now = performance.now();
            if (loaded < total && now - lastTick < 100) return;
            lastTick = now;
            uploads = uploads.map((u) => (u.id === item.id ? { ...u, loaded, total } : u));
          },
        });
        uploads = uploads.map((u) =>
          u.id === item.id ? { ...u, status: 'done', loaded: u.total } : u,
        );
      } catch (e) {
        uploads = uploads.map((u) =>
          u.id === item.id ? { ...u, status: 'error', error: String(e) } : u,
        );
      }
    }
    filesPanel?.refresh();
    // Keep failures and any still-running uploads on screen; clear the rest.
    setTimeout(() => {
      uploads = uploads.filter((u) => u.status !== 'done');
    }, 4000);
  }

  function dismissUpload(id: number): void {
    uploads = uploads.filter((u) => u.id !== id);
  }

  const STATUS_LABEL: Record<'connecting' | 'open' | 'closed', string> = {
    connecting: '连接中',
    open: '已连接',
    closed: '已断开',
  };

  let mq: MediaQueryList | undefined;
  let onMqChange: ((e: MediaQueryListEvent) => void) | undefined;

  onMount(async () => {
    mq = window.matchMedia(`(max-width: ${NARROW_BREAKPOINT}px)`);
    isNarrow = mq.matches;
    onMqChange = (e) => {
      isNarrow = e.matches;
      if (!e.matches) {
        drawerLeft = false;
        drawerRight = false;
      }
    };
    mq.addEventListener('change', onMqChange);

    try {
      const s = await api.getSession(sessionId);
      session = s;
      title = s.title;
      api.getShare(sessionId).then((r) => (shareToken = r.token)).catch(() => { /* ignore */ });
    } catch (e) {
      if (String(e).includes('404')) notFound = true;
    }
  });

  onDestroy(() => {
    if (mq && onMqChange) mq.removeEventListener('change', onMqChange);
  });

  function toggleDrawer(side: 'left' | 'right'): void {
    if (side === 'left') {
      drawerLeft = !drawerLeft;
      if (drawerLeft) drawerRight = false;
    } else {
      drawerRight = !drawerRight;
      if (drawerRight) drawerLeft = false;
    }
  }

  function closeDrawers(): void {
    drawerLeft = false;
    drawerRight = false;
  }

  async function newSessionInDir(absDir: string) {
    // Open the tab synchronously inside the click so popup blockers stay happy.
    const popup = window.open('about:blank', '_blank');
    try {
      const s = await api.createSession({ ...estimateTermSize(), cwd: absDir });
      const url = `${location.pathname}${location.search}#/s/${s.id}`;
      if (popup) popup.location.href = url;
      else navigate({ name: 'terminal', id: s.id });
    } catch (e) {
      if (popup) popup.close();
      alert(`新建会话失败：${e}`);
    }
  }

  async function destroy() {
    if (!confirm(`确认销毁会话「${title}」？`)) return;
    try { await api.deleteSession(sessionId); } catch { /* */ }
    closeOrNavigate();
  }

  function closeOrNavigate() {
    refreshHistoryAfterSessionClose();
    try { window.close(); } catch { /* */ }
    setTimeout(() => { if (!window.closed) navigate({ name: 'list' }); }, 60);
  }
</script>

<div class="wrap">
  <header>
    <button class="ghost back" onclick={closeOrNavigate} aria-label="关闭或返回会话列表" title="关闭此标签页（不可关闭时回到会话列表）">
      <Icon name="arrow-left" size={16} />
    </button>

    {#if isNarrow && session}
      <button
        class="ghost icon-only drawer-toggle"
        class:active={drawerLeft}
        onclick={() => toggleDrawer('left')}
        aria-label="文件侧栏"
        title="文件"
      >
        <Icon name="folder" size={16} />
      </button>
    {/if}

    <span class="title-icon"><Icon name="terminal" size={14} /></span>
    <span class="title">{title}</span>

    <div class="spacer"></div>

    <span class="status status-{status}" title={STATUS_LABEL[status]}>
      <span class="dot"><Icon name="circle" size={8} /></span>
      <span class="status-text">{STATUS_LABEL[status]}</span>
    </span>

    {#if clientCount > 1}
      <span class="clients" title="多端同时连接">
        <Icon name="users" size={13} />
        <span>{clientCount}</span>
      </span>
    {/if}

    {#if exitInfo}
      <span class="exited" title="shell 已退出">
        <Icon name="eye-off" size={13} />
        <span class="exited-text">已退出（{exitInfo.code ?? exitInfo.signal}）</span>
      </span>
    {/if}

    {#if isNarrow && session}
      <button
        class="ghost icon-only drawer-toggle"
        class:active={drawerRight}
        onclick={() => toggleDrawer('right')}
        aria-label="Git 侧栏"
        title="Git"
      >
        <Icon name="git-branch" size={16} />
      </button>
    {/if}

    {#if recording}
      <span class="rec-pill" title="正在录制终端（asciinema）">
        <span class="rec-dot"></span>REC
      </span>
    {/if}

    <button
      class="ghost icon-only"
      class:active={!!shareToken}
      title={shareToken ? '已生成只读分享链接（点击复制）' : '生成只读分享链接'}
      aria-label="分享只读链接"
      disabled={shareBusy}
      onclick={shareSession}
    >
      {#if shareCopied}
        <Icon name="check" size={15} />
      {:else}
        <Icon name="share" size={15} />
      {/if}
    </button>

    <div class="menu-anchor">
      <button
        class="ghost icon-only"
        class:active={menuOpen}
        title="导出 / 录制"
        aria-label="导出或录制终端"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon name="download" size={15} />
      </button>
      {#if menuOpen}
        <button class="menu-backdrop" aria-label="关闭菜单" onclick={() => (menuOpen = false)}></button>
        <div class="menu" role="menu">
          <button class="menu-item" role="menuitem" onclick={() => exportAs('txt')}>
            <Icon name="file" size={14} /> 导出纯文本 (.txt)
          </button>
          <button class="menu-item" role="menuitem" onclick={() => exportAs('html')}>
            <Icon name="globe" size={14} /> 导出彩色 HTML
          </button>
          <button class="menu-item" role="menuitem" onclick={() => exportAs('cast')}>
            <Icon name="circle" size={14} />
            {recording ? '停止录制并下载 (.cast)' : '开始录制 (asciinema)'}
          </button>
          {#if shareToken}
            <div class="menu-sep"></div>
            <button class="menu-item danger" role="menuitem" onclick={() => { menuOpen = false; revokeShare(); }}>
              <Icon name="link" size={14} /> 撤销分享链接
            </button>
          {/if}
        </div>
      {/if}
    </div>

    <button
      class="ghost icon-only"
      title={`主题：${THEME_LABEL[$themePref]}（点击切换）`}
      aria-label="切换主题"
      onclick={cycleTheme}
    >
      {#if $themePref === 'light'}
        <Icon name="sun" size={15} />
      {:else if $themePref === 'dark'}
        <Icon name="moon" size={15} />
      {:else}
        <Icon name="monitor" size={15} />
      {/if}
    </button>

    <button class="ghost icon-only danger" onclick={destroy} title="销毁会话" aria-label="销毁会话">
      <Icon name="trash" size={15} />
    </button>
  </header>

  <div
    class="body"
    class:narrow={isNarrow}
    class:left-open={drawerLeft}
    class:right-open={drawerRight}
  >
    {#if isNarrow && (drawerLeft || drawerRight)}
      <button class="drawer-backdrop" aria-label="关闭侧栏" onclick={closeDrawers}></button>
    {/if}

    {#if session}
      <div class="side-slot left">
        <FilesPanel bind:this={filesPanel} {sessionId} onNewSession={newSessionInDir} />
      </div>
    {/if}

    <div
      class="term"
      class:dragging
      role="region"
      aria-label="终端，可拖拽文件到此上传"
      ondragenter={onDragEnter}
      ondragover={onDragOver}
      ondragleave={onDragLeave}
      ondrop={onDrop}
    >
      {#if notFound}
        <div class="empty">
          <Icon name="alert" size={22} />
          <p>会话不存在，可能已经被销毁。</p>
          <button class="primary" onclick={closeOrNavigate}>关闭</button>
        </div>
      {:else if session}
        <XTerm
          bind:this={xterm}
          {sessionId}
          {title}
          onTitle={(t) => (title = t)}
          onClientCount={(n) => (clientCount = n)}
          onExit={(info) => (exitInfo = info)}
          onStatus={(s) => (status = s)}
          onRecordingChange={(r) => (recording = r)}
          onOpenPath={openTerminalPath}
        />
      {/if}

      {#if dragging && session}
        <div class="drop-overlay">
          <div class="drop-card">
            <Icon name="upload" size={28} />
            <p class="drop-title">释放以上传到当前目录</p>
            {#if dropTarget}
              <p class="drop-path" title={dropTarget}>{dropTarget}</p>
            {/if}
          </div>
        </div>
      {/if}

      {#if uploads.length}
        <div class="uploads">
          {#each uploads as u (u.id)}
            <div class="upload-item" class:error={u.status === 'error'} class:done={u.status === 'done'}>
              <span class="up-icon">
                {#if u.status === 'done'}
                  <Icon name="check" size={14} />
                {:else if u.status === 'error'}
                  <Icon name="alert" size={14} />
                {:else}
                  <Icon name="upload" size={14} />
                {/if}
              </span>
              <div class="up-body">
                <div class="up-row">
                  <span class="up-name" title={u.name}>{u.name}</span>
                  <button class="up-dismiss" onclick={() => dismissUpload(u.id)} aria-label="移除" title="移除">
                    <Icon name="x" size={12} />
                  </button>
                </div>
                {#if u.status === 'uploading'}
                  <div class="up-bar"><div class="up-fill" style={`width: ${u.total ? Math.round((u.loaded / u.total) * 100) : 0}%`}></div></div>
                  <span class="up-meta">{fmtBytes(u.loaded)} / {fmtBytes(u.total)}</span>
                {:else if u.status === 'done'}
                  <span class="up-meta ok">已上传 · {fmtBytes(u.total)}</span>
                {:else}
                  <span class="up-meta err">上传失败</span>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    {#if session}
      <div class="side-slot right">
        <GitPanel {sessionId} />
      </div>
    {/if}
  </div>
</div>

{#if editingPath && EditorModal}
  <EditorModal
    {sessionId}
    path={editingPath}
    root={editingRoot}
    onClose={() => (editingPath = null)}
    onSaved={() => filesPanel?.refresh()}
  />
{/if}

<style>
  .wrap { display: flex; flex-direction: column; height: 100%; background: var(--bg-soft); min-height: 0; }
  header {
    display: flex; align-items: center; gap: 8px;
    background: var(--bg-elev);
    border-bottom: 1px solid var(--border);
    padding: 8px 12px;
    font-size: 13px;
    flex-shrink: 0;
  }
  .back { padding: 0; width: 32px; height: 32px; }
  .drawer-toggle.active { background: var(--accent-soft); color: var(--accent); }
  :global(.ghost.icon-only.active) { background: var(--accent-soft); color: var(--accent); }

  .rec-pill {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--danger-soft); color: var(--danger);
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em;
  }
  .rec-dot {
    width: 7px; height: 7px; border-radius: 50%;
    background: var(--danger);
    animation: rec-pulse 1.1s ease-in-out infinite;
  }
  @keyframes rec-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

  .menu-anchor { position: relative; display: inline-flex; }
  .menu-backdrop {
    position: fixed; inset: 0; z-index: 40;
    border: none; background: transparent; padding: 0; margin: 0; cursor: default;
  }
  .menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 41;
    min-width: 220px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
    padding: 4px;
    display: flex; flex-direction: column; gap: 1px;
  }
  .menu-item {
    display: flex; align-items: center; gap: 9px;
    width: 100%;
    padding: 8px 10px;
    border: none; background: transparent;
    color: var(--fg);
    font-size: 13px;
    text-align: left;
    border-radius: 6px;
    cursor: pointer;
  }
  .menu-item:hover { background: var(--bg-hover); }
  .menu-item.danger { color: var(--danger); }
  .menu-item.danger:hover { background: var(--danger-soft); }
  .menu-item > :global(svg) { flex-shrink: 0; color: var(--fg-muted); }
  .menu-item.danger > :global(svg) { color: var(--danger); }
  .menu-sep { height: 1px; background: var(--border); margin: 4px 2px; }
  .title-icon { color: var(--accent); display: inline-flex; }
  .title {
    font-weight: 600;
    color: var(--fg);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .spacer { flex: 1; }

  .status {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
  }
  .status .dot { display: inline-flex; }
  .status-connecting { background: var(--warning-soft); color: var(--warning); }
  .status-open { background: var(--success-soft); color: var(--success); }
  .status-closed { background: var(--danger-soft); color: var(--danger); }

  .clients {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
  }

  .exited {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--danger);
    background: var(--danger-soft);
    border-radius: 999px;
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: stretch;
    position: relative;
  }

  .side-slot {
    flex-shrink: 0;
    min-height: 0;
    display: flex;
  }

  .term {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 10px;
    background: var(--bg-soft);
    display: flex;
    position: relative;
  }

  .drop-overlay {
    position: absolute;
    inset: 10px;
    z-index: 30;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    border: 2px dashed var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, var(--bg-elev));
    pointer-events: none;
    backdrop-filter: blur(1px);
  }
  .drop-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    text-align: center;
    padding: 0 16px;
    max-width: 100%;
  }
  .drop-title { margin: 0; font-size: 15px; font-weight: 600; }
  .drop-path {
    margin: 0;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 12px;
    color: var(--fg-muted);
    max-width: min(420px, 80vw);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: ltr;
  }

  .uploads {
    position: absolute;
    right: 18px;
    bottom: 18px;
    z-index: 31;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(320px, calc(100% - 36px));
    pointer-events: none;
  }
  .upload-item {
    pointer-events: auto;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-md);
    padding: 10px 12px;
  }
  .upload-item.done { border-left-color: var(--success); }
  .upload-item.error { border-left-color: var(--danger); }
  .up-icon { display: inline-flex; color: var(--accent); margin-top: 1px; flex-shrink: 0; }
  .upload-item.done .up-icon { color: var(--success); }
  .upload-item.error .up-icon { color: var(--danger); }
  .up-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .up-row { display: flex; align-items: center; gap: 8px; }
  .up-name {
    flex: 1;
    min-width: 0;
    font-size: 12.5px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: ltr;
  }
  .up-dismiss {
    flex-shrink: 0;
    width: 20px; height: 20px;
    padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border: none; background: transparent;
    color: var(--fg-muted); cursor: pointer; border-radius: 4px;
  }
  .up-dismiss:hover { background: var(--bg-hover); color: var(--fg); }
  .up-bar { height: 5px; border-radius: 999px; background: var(--bg-hover); overflow: hidden; }
  .up-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.12s linear; }
  .up-meta { font-size: 11px; color: var(--fg-muted); }
  .up-meta.ok { color: var(--success); }
  .up-meta.err { color: var(--danger); }
  .term :global(.xterm-host) {
    background: var(--term-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .term :global(.xterm) {
    padding: 6px 12px;
    box-sizing: border-box;
    height: 100%;
  }

  .empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; width: 100%;
    gap: 12px;
    color: var(--fg-muted);
  }
  .empty p { margin: 0; font-size: 14px; }

  .drawer-backdrop {
    position: absolute;
    inset: 0;
    z-index: 15;
    border: none;
    padding: 0;
    margin: 0;
    background: rgba(15, 23, 42, 0.35);
    cursor: default;
  }

  @media (max-width: 768px) {
    .status-text,
    .exited-text {
      display: none;
    }

    .body.narrow .side-slot {
      position: absolute;
      top: 0;
      bottom: 0;
      z-index: 20;
      pointer-events: none;
    }

    .body.narrow .side-slot :global(aside.panel) {
      width: min(320px, 88vw) !important;
      min-width: 0 !important;
      max-width: none !important;
      flex: none !important;
      height: 100%;
      box-shadow: var(--shadow-md);
      transform: translateX(-110%);
      transition: transform 0.2s ease;
      pointer-events: auto;
    }

    .body.narrow .side-slot.right :global(aside.panel) {
      transform: translateX(110%);
    }

    .body.narrow.left-open .side-slot.left :global(aside.panel) {
      transform: translateX(0);
    }

    .body.narrow.right-open .side-slot.right :global(aside.panel) {
      transform: translateX(0);
    }

    .body.narrow .side-slot.left {
      left: 0;
    }

    .body.narrow .side-slot.right {
      right: 0;
    }

    .body.narrow:not(.left-open):not(.right-open) .side-slot {
      width: 0;
      overflow: hidden;
    }
  }
</style>

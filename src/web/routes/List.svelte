<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { sessions, startSessionPolling, stopSessionPolling, refreshSessions, checkAuth } from '../lib/stores.js';
  import { api, apiBase, type PublicSite } from '../lib/api.js';
  import { themePref, cycleTheme, THEME_LABEL } from '../lib/theme.js';
  import {
    notifyPref,
    enableNotifications,
    disableNotifications,
    startAgentWatcher,
    notificationsSupported,
  } from '../lib/notifications.js';
  import { refreshHistoryAfterSessionClose } from '../lib/history-cache.js';
  import { navigate } from '../lib/router.js';
  import { groupSessionsByProject } from '../lib/session-group.js';
  import type { Session } from '../../shared/session.js';
  import Icon from '../components/Icon.svelte';
  import SystemPanel from '../components/SystemPanel.svelte';
  import NewSessionDialog from '../components/NewSessionDialog.svelte';

  let showNewDialog = $state(false);
  let error = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');

  const GROUP_KEY = 'omas-group';
  const COLLAPSE_KEY = 'omas-group-collapsed';

  function readGrouped(): boolean {
    try {
      return localStorage.getItem(GROUP_KEY) !== '0';
    } catch {
      return true;
    }
  }
  function readCollapsed(): Set<string> {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {
      /* ignore */
    }
    return new Set();
  }

  let grouped = $state(readGrouped());
  let collapsed = $state(readCollapsed());

  const groups = $derived(groupSessionsByProject($sessions));

  function toggleGrouped() {
    grouped = !grouped;
    try {
      localStorage.setItem(GROUP_KEY, grouped ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  function toggleCollapse(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    collapsed = next;
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore */
    }
  }

  const AGENT_LABEL: Record<string, string> = {
    claude: 'Claude',
    cursor: 'Cursor',
    qoder: 'Qoder',
  };

  const notifySupported = notificationsSupported();
  let stopWatcher: (() => void) | null = null;

  let sites = $state<PublicSite[]>([]);
  let copiedSlug = $state<string | null>(null);

  /** Absolute, shareable URL for a published site (honors any reverse-proxy base). */
  function siteHref(slug: string): string {
    const base = apiBase.replace(/api\/$/, '');
    return new URL(`p/${slug}/`, new URL(base, location.href)).href;
  }

  async function copySite(slug: string) {
    try {
      await navigator.clipboard.writeText(siteHref(slug));
      copiedSlug = slug;
      setTimeout(() => { if (copiedSlug === slug) copiedSlug = null; }, 1500);
    } catch {
      /* clipboard blocked */
    }
  }

  onMount(() => {
    startSessionPolling();
    stopWatcher = startAgentWatcher();
    api.listSites().then((r) => { sites = r.sites; }).catch(() => { /* ignore */ });
  });
  onDestroy(() => {
    stopSessionPolling();
    stopWatcher?.();
  });

  async function toggleNotify() {
    if ($notifyPref === 'on') {
      disableNotifications();
      return;
    }
    const ok = await enableNotifications();
    if (!ok) error = '无法开启通知：请在浏览器中允许本站发送通知。';
  }

  function openNewDialog() {
    error = null;
    showNewDialog = true;
  }

  async function destroy(id: string, title: string) {
    if (!confirm(`确认销毁会话「${title}」？所属 shell 进程会被立即终止。`)) return;
    try {
      await api.deleteSession(id);
      await refreshSessions();
      refreshHistoryAfterSessionClose();
    } catch (e) {
      error = `销毁失败：${e}`;
    }
  }

  function startRename(id: string, current: string) {
    renamingId = id;
    renameValue = current;
  }

  async function commitRename() {
    if (!renamingId || !renameValue.trim()) {
      renamingId = null;
      return;
    }
    const id = renamingId;
    const title = renameValue.trim();
    renamingId = null;
    try {
      await api.renameSession(id, title);
      await refreshSessions();
    } catch (e) {
      error = `重命名失败：${e}`;
    }
  }

  async function logout() {
    await fetch(apiBase + 'auth/logout', { method: 'POST', credentials: 'same-origin' });
    await checkAuth();
  }

  /** Compact cwd for the card: keep the last two path segments, full path in tooltip. */
  function fmtCwd(p: string): string {
    const parts = p.split('/').filter(Boolean);
    if (parts.length === 0) return '/';
    if (parts.length <= 2) return '/' + parts.join('/');
    return '…/' + parts.slice(-2).join('/');
  }

  function fmtAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 10) return '刚刚';
    if (s < 60) return `${s} 秒前`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    return `${Math.floor(h / 24)} 天前`;
  }
</script>

<div class="layout">
  <SystemPanel />
  <div class="page">
  <header>
    <div class="brand">
      <span class="logo"><Icon name="terminal" size={18} /></span>
      <div>
        <div class="title">会话</div>
        <div class="subtitle">共 {$sessions.length} 个</div>
      </div>
    </div>
    <button
      class="ghost icon-only"
      class:notify-on={grouped}
      title={grouped ? '按项目分组：开（点击平铺）' : '按项目分组：关（点击分组）'}
      aria-label="切换按项目分组"
      aria-pressed={grouped}
      onclick={toggleGrouped}
    >
      <Icon name="layers" size={16} />
    </button>
    {#if notifySupported}
      <button
        class="ghost icon-only"
        class:notify-on={$notifyPref === 'on'}
        title={$notifyPref === 'on' ? 'Agent 空闲通知：开（点击关闭）' : 'Agent 空闲通知：关（点击开启）'}
        aria-label="切换 Agent 空闲通知"
        aria-pressed={$notifyPref === 'on'}
        onclick={toggleNotify}
      >
        {#if $notifyPref === 'on'}
          <Icon name="bell" size={16} />
        {:else}
          <Icon name="bell-off" size={16} />
        {/if}
      </button>
    {/if}
    <button
      class="ghost icon-only"
      title={`主题：${THEME_LABEL[$themePref]}（点击切换）`}
      aria-label="切换主题"
      onclick={cycleTheme}
    >
      {#if $themePref === 'light'}
        <Icon name="sun" size={16} />
      {:else if $themePref === 'dark'}
        <Icon name="moon" size={16} />
      {:else}
        <Icon name="monitor" size={16} />
      {/if}
    </button>
    <button
      class="ghost icon-only"
      title="命令面板（⌘/Ctrl + K）"
      aria-label="打开命令面板"
      onclick={() => window.dispatchEvent(new Event('omas:command-palette'))}
    >
      <Icon name="command" size={16} />
    </button>
    <button class="ghost" title="管理免密公开站点" onclick={() => navigate({ name: 'publish' })}>
      <Icon name="globe" size={16} />
      <span>发布</span>
    </button>
    <button class="ghost" title="从 Claude 等工具历史中恢复" onclick={() => navigate({ name: 'history' })}>
      <Icon name="clock" size={16} />
      <span>历史</span>
    </button>
    <button class="ghost" title="退出登录" aria-label="退出登录" onclick={logout}>
      <Icon name="log-out" size={16} />
      <span>退出</span>
    </button>
    <button class="primary" onclick={openNewDialog}>
      <Icon name="plus" size={14} />
      新建会话
    </button>
  </header>

  {#if showNewDialog}
    <NewSessionDialog onClose={() => (showNewDialog = false)} />
  {/if}

  {#if error}
    <p class="error"><Icon name="alert" size={14} /> {error}</p>
  {/if}

  {#if sites.length > 0}
    <section class="sites">
      <div class="sites-head">
        <Icon name="globe" size={14} />
        <span>公开站点</span>
        <span class="sites-hint">免密访问 · 可分享</span>
        <button class="sites-manage" onclick={() => navigate({ name: 'publish' })}>管理</button>
      </div>
      <ul class="sites-list">
        {#each sites as site (site.slug)}
          <li class="site">
            <a class="site-link" href={siteHref(site.slug)} target="_blank" rel="noopener" title={site.root}>
              <span class="site-slug">/p/{site.slug}/</span>
              {#if site.spa}<span class="site-tag">SPA</span>{/if}
              <span class="site-root">{site.root}</span>
            </a>
            <button
              class="ghost icon-only"
              title="复制公开链接"
              aria-label="复制公开链接"
              onclick={() => copySite(site.slug)}
            >
              {#if copiedSlug === site.slug}
                <Icon name="check" size={15} />
              {:else}
                <Icon name="copy" size={15} />
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#snippet card(s: Session)}
    <li class="card">
      <!-- Sessions are designed to live in their own tab: open one when you
           start work, close the tab when done, click the card to re-open
           later. So target="_blank" is the default; the main page stays put.
           rel="noopener" cuts the cross-tab JS handle for tabnabbing safety. -->
      <a class="open" href="#/s/{s.id}" target="_blank" rel="noopener" aria-label={`在新标签页打开会话 ${s.title}`}>
        <div class="card-head">
          <span class="card-icon"><Icon name="terminal" size={16} /></span>
          {#if renamingId === s.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              class="rename"
              bind:value={renameValue}
              onblur={commitRename}
              onkeydown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') renamingId = null; }}
              onclick={(e) => { e.stopPropagation(); e.preventDefault(); }}
              autofocus
            />
          {:else}
            <span class="card-title">{s.title}</span>
          {/if}
          {#if s.agent}
            <span
              class="agent-badge agent-{s.agent}"
              title={`当前运行：${AGENT_LABEL[s.agent] ?? s.agent}${s.agentState ? `（${s.agentState === 'active' ? '工作中' : '空闲'}）` : ''}`}
            >
              {#if s.agentState}
                <span class="state-dot" class:active={s.agentState === 'active'}></span>
              {/if}
              <Icon name="sparkles" size={12} />
              {AGENT_LABEL[s.agent] ?? s.agent}
              {#if s.agentState}
                <span class="state-text">· {s.agentState === 'active' ? '工作中' : '空闲'}</span>
              {/if}
            </span>
          {:else if s.foreground}
            <span class="fg-badge" title={`前台进程：${s.foreground}`}>{s.foreground}</span>
          {/if}
        </div>
        <div class="meta">
          {#if (s.liveCwd ?? s.cwd) && !grouped}
            <span class="chip chip-cwd" title={`工作目录：${s.liveCwd ?? s.cwd}`}>
              <Icon name="folder" size={12} />
              {fmtCwd((s.liveCwd ?? s.cwd) as string)}
            </span>
          {/if}
          <span class="chip" title="使用的 shell">{s.shell.split('/').pop()}</span>
          <span class="chip" title="终端尺寸">{s.cols} × {s.rows}</span>
          <span class="chip" title={s.lastActivityAt}>活跃于 {fmtAgo(s.lastActivityAt)}</span>
          {#if s.clientCount > 0}
            <span class="chip chip-accent" title="当前已连接的浏览器数量">
              <Icon name="users" size={12} />
              {s.clientCount}
            </span>
          {/if}
        </div>
      </a>
      <div class="actions">
        <button class="ghost icon-only" title="重命名" aria-label="重命名" onclick={() => startRename(s.id, s.title)}>
          <Icon name="pencil" size={15} />
        </button>
        <button class="ghost icon-only danger" title="销毁会话" aria-label="销毁会话" onclick={() => destroy(s.id, s.title)}>
          <Icon name="trash" size={15} />
        </button>
      </div>
    </li>
  {/snippet}

  {#if $sessions.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="monitor" size={28} /></span>
      <h3>暂无会话</h3>
      <p>点击右上角「新建会话」开启第一个终端。</p>
    </div>
  {:else if grouped}
    <div class="groups">
      {#each groups as g (g.key)}
        {@const isCollapsed = collapsed.has(g.key)}
        {@const segs = g.full ? g.full.split('/').filter(Boolean) : []}
        <section class="group">
          <button
            class="group-head"
            aria-expanded={!isCollapsed}
            onclick={() => toggleCollapse(g.key)}
            title={g.full || '无工作目录'}
          >
            <span class="group-chevron" class:expanded={!isCollapsed}>
              <Icon name="chevron-right" size={14} />
            </span>
            <span class="group-folder"><Icon name="folder" size={14} /></span>
            {#if segs.length > 0}
              <span class="group-path">
                {#each segs as seg, i (i)}
                  {#if i > 0}
                    <span class="path-sep"><Icon name="chevron-right" size={10} /></span>
                  {/if}
                  <span class="path-seg" class:leaf={i === segs.length - 1}>{seg}</span>
                {/each}
              </span>
            {:else}
              <span class="group-label">其他</span>
            {/if}
            <span class="group-count">{g.sessions.length}</span>
          </button>
          {#if !isCollapsed}
            <ul class="grid">
              {#each g.sessions as s (s.id)}
                {@render card(s)}
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    </div>
  {:else}
    <ul class="grid">
      {#each $sessions as s (s.id)}
        {@render card(s)}
      {/each}
    </ul>
  {/if}
  </div>
</div>

<style>
  .layout {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .page {
    flex: 1;
    padding: 32px 28px;
    max-width: 960px;
    margin: 0 auto;
    width: 100%;
    overflow-y: auto;
  }
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 24px;
  }
  .brand { display: flex; align-items: center; gap: 12px; flex: 1; min-width: 0; }
  .logo {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-sm);
  }
  .title { font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
  .subtitle { color: var(--fg-muted); font-size: 12px; margin-top: 1px; }

  .notify-on { color: var(--accent); background: var(--accent-soft); }

  .error {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
    border-radius: var(--radius-sm);
    padding: 8px 12px;
    margin: 0 0 16px;
    font-size: 13px;
  }

  .empty {
    display: flex; flex-direction: column; align-items: center;
    text-align: center;
    padding: 64px 24px;
    color: var(--fg-muted);
  }
  .empty-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 60px; height: 60px; margin-bottom: 16px;
    background: var(--bg-hover);
    border-radius: 50%;
    color: var(--fg-muted);
  }
  .empty h3 { margin: 0 0 6px; color: var(--fg); font-weight: 600; font-size: 15px; }
  .empty p { margin: 0; font-size: 13px; }

  .sites {
    margin-bottom: 20px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elev);
    overflow: hidden;
  }
  .sites-head {
    display: flex; align-items: center; gap: 7px;
    padding: 10px 14px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--fg);
    border-bottom: 1px solid var(--border);
  }
  .sites-head > :global(svg) { color: var(--accent); }
  .sites-hint { color: var(--fg-muted); font-weight: 400; font-size: 11.5px; flex: 1; }
  .sites-manage {
    border: none; background: none; cursor: pointer;
    color: var(--accent); font-size: 12px; font-weight: 600;
    padding: 2px 6px; border-radius: var(--radius-sm);
  }
  .sites-manage:hover { background: var(--accent-soft); }
  .sites-list { list-style: none; margin: 0; padding: 4px; display: flex; flex-direction: column; gap: 2px; }
  .site { display: flex; align-items: center; gap: 6px; }
  .site-link {
    flex: 1; min-width: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 7px 10px;
    border-radius: var(--radius-sm);
    text-decoration: none;
    color: inherit;
  }
  .site-link:hover { background: var(--bg-hover); }
  .site-slug { font-family: var(--mono, monospace); font-size: 13px; font-weight: 600; color: var(--accent); flex-shrink: 0; }
  .site-tag {
    flex-shrink: 0;
    background: var(--accent-soft); color: var(--accent);
    border-radius: 999px; padding: 1px 7px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.02em;
  }
  .site-root {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: var(--mono, monospace);
    font-size: 11.5px;
    color: var(--fg-muted);
    text-align: right;
  }

  .grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }

  .groups { display: flex; flex-direction: column; gap: 16px; }
  .group { display: flex; flex-direction: column; gap: 8px; }
  .group-head {
    display: flex; align-items: center; justify-content: flex-start; gap: 7px;
    width: 100%;
    height: auto;
    padding: 4px 4px;
    background: none;
    border: none;
    color: var(--fg-muted);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    text-align: left;
    border-radius: var(--radius-sm);
  }
  .group-head:hover { color: var(--fg); background: var(--bg-hover); }
  .group-chevron {
    display: inline-flex;
    transition: transform 0.12s ease;
    flex-shrink: 0;
  }
  .group-chevron.expanded { transform: rotate(90deg); }
  .group-label {
    /* Pack left next to the icons (no flex-grow) so a short path doesn't get
       stretched away from the count badge and read as "centered"; shrink with
       an ellipsis only when the row is too narrow. */
    flex: 0 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    text-align: left;
    font-family: var(--mono, monospace);
    color: var(--fg);
  }
  .group-folder { display: inline-flex; color: var(--accent); flex-shrink: 0; }

  /* oh-my-zsh / agnoster-style breadcrumb: muted ancestors, chevron arrows,
     and the current project segment highlighted in the accent color. */
  .group-path {
    flex: 0 1 auto; min-width: 0;
    display: flex; align-items: center; gap: 2px;
    overflow: hidden;
    font-family: var(--mono, monospace);
  }
  .path-seg {
    white-space: nowrap;
    color: var(--fg-muted);
  }
  .path-seg.leaf {
    color: var(--accent);
    font-weight: 700;
  }
  .path-sep {
    display: inline-flex;
    color: var(--accent);
    opacity: 0.7;
    flex-shrink: 0;
  }
  .group-count {
    flex-shrink: 0;
    background: var(--bg-hover);
    color: var(--fg-muted);
    border-radius: 999px;
    padding: 1px 9px;
    font-size: 11px;
    font-weight: 600;
  }

  .card {
    display: flex;
    align-items: stretch;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: border-color 80ms ease, box-shadow 80ms ease;
  }
  .card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }

  .open {
    flex: 1; min-width: 0;
    background: none; border: none;
    text-decoration: none;
    color: inherit;
    text-align: left;
    padding: 14px 16px;
    border-radius: 0;
    height: auto;
    cursor: pointer;
    display: flex; flex-direction: column; gap: 8px;
  }
  .open:hover { background: var(--bg-hover); border-color: transparent; }

  .card-head { display: flex; align-items: center; gap: 8px; }
  .card-icon { color: var(--accent); display: inline-flex; }
  .card-title { font-weight: 600; font-size: 14.5px; color: var(--fg); }

  .agent-badge {
    display: inline-flex; align-items: center; gap: 4px;
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.5;
    white-space: nowrap;
  }
  .agent-claude { background: color-mix(in srgb, #cc7a33 16%, var(--bg-elev)); color: #cc7a33; }
  .agent-cursor { background: color-mix(in srgb, #8089a8 16%, var(--bg-elev)); color: #8089a8; }
  .agent-qoder  { background: color-mix(in srgb, var(--accent) 16%, var(--bg-elev)); color: var(--accent); }

  .state-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--fg-muted);
    flex-shrink: 0;
    opacity: 0.65;
  }
  .state-dot.active {
    background: var(--success);
    opacity: 1;
    animation: state-pulse 1.3s ease-in-out infinite;
  }
  @keyframes state-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.35; transform: scale(0.8); }
  }
  .state-text { font-weight: 500; opacity: 0.8; }
  .fg-badge {
    display: inline-flex; align-items: center;
    background: var(--bg-hover);
    color: var(--fg-muted);
    border-radius: 999px;
    padding: 2px 9px;
    font-size: 11px;
    font-family: var(--mono, monospace);
    line-height: 1.5;
    white-space: nowrap;
  }
  .rename {
    flex: 1; padding: 4px 8px; font-size: 14px; font-weight: 600;
  }

  .meta { display: flex; gap: 6px; flex-wrap: wrap; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg-hover);
    color: var(--fg-muted);
    border-radius: 999px;
    padding: 2px 10px;
    font-size: 11.5px;
    line-height: 1.5;
  }
  .chip-accent {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
  }
  .chip-cwd {
    max-width: 240px;
    color: var(--fg);
    font-family: var(--mono, monospace);
  }
  .chip-cwd > :global(svg) { flex-shrink: 0; color: var(--fg-muted); }

  .actions {
    display: flex; align-items: center; gap: 4px;
    padding: 0 8px;
  }
</style>

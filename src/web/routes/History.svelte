<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { api, type HistorySession, type HistorySource } from '../lib/api.js';
  import {
    subscribeHistory,
    refreshHistoryCache,
    getHistorySnapshot,
    type HistorySnapshot,
  } from '../lib/history-cache.js';
  import { historySessionsEqual } from '../lib/stable-update.js';
  import { estimateTermSize } from '../lib/term-size.js';
  import { navigate } from '../lib/router.js';
  import { refreshSessions } from '../lib/stores.js';
  import Icon from '../components/Icon.svelte';

  let sessions = $state<HistorySession[]>([]);
  let initialLoading = $state(true);
  let refreshing = $state(false);
  let error = $state<string | null>(null);
  /** Tagged with the kind we're resuming as so we can disable both buttons. */
  let resumingId = $state<string | null>(null);
  let filterRaw = $state('');
  let filter = $state('');
  let filterTimer: ReturnType<typeof setTimeout> | undefined;
  function onFilterInput(): void {
    clearTimeout(filterTimer);
    // Debounce so filtering + regrouping a large history doesn't run on every keystroke.
    filterTimer = setTimeout(() => { filter = filterRaw; }, 150);
  }
  let activeSource = $state<HistorySource | 'all'>('all');
  let lastFetchAt = $state<number>(0);
  let pageEl = $state<HTMLElement | undefined>(undefined);
  /** Project cwd keys — collapsed by default. */
  let expandedGroups = $state<Set<string>>(new Set());

  const SOURCE_META: Record<HistorySource, { label: string; color: string }> = {
    'claude-code':  { label: 'Claude',     color: '#cc785c' },  // Anthropic terracotta
    'qoder':        { label: 'Qoder',      color: '#5b8def' },  // qoder blue-ish
    'cursor-agent': { label: 'Cursor',     color: '#10b981' },  // emerald
    'opencode':     { label: 'OpenCode',   color: '#a855f7' },  // violet
  };

  let inFlight = false;
  let unsubHistory: (() => void) | undefined;

  function applySnapshot(snap: HistorySnapshot) {
    if (historySessionsEqual(sessions, snap.sessions) && lastFetchAt === snap.lastFetchAt) {
      if (snap.lastFetchAt > 0) initialLoading = false;
      return;
    }
    const scrollY = pageEl?.scrollTop ?? 0;
    sessions = snap.sessions;
    lastFetchAt = snap.lastFetchAt;
    if (snap.error) error = snap.error;
    else if (!refreshing) error = null;
    if (snap.lastFetchAt > 0) initialLoading = false;
    void tick().then(() => {
      if (pageEl) pageEl.scrollTop = scrollY;
    });
  }

  async function refresh(manual = false) {
    if (inFlight) return;
    inFlight = true;
    if (manual || initialLoading) refreshing = true;
    if (manual) error = null;
    try {
      await refreshHistoryCache({ silent: !manual && !initialLoading, force: manual });
    } finally {
      initialLoading = false;
      refreshing = false;
      inFlight = false;
    }
  }

  onMount(() => {
    unsubHistory = subscribeHistory(applySnapshot);
    if (getHistorySnapshot().lastFetchAt === 0) void refresh();
    else initialLoading = false;
  });

  onDestroy(() => {
    unsubHistory?.();
  });

  function fmtFreshness(): string {
    if (!lastFetchAt) return '';
    return `更新于 ${new Date(lastFetchAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  function toggleGroup(cwd: string) {
    const next = new Set(expandedGroups);
    if (next.has(cwd)) next.delete(cwd);
    else next.add(cwd);
    expandedGroups = next;
  }

  async function resume(s: HistorySession, command: string, kind: 'plain' | 'safe') {
    if (resumingId) return;
    if (!s.cwdExists) {
      if (!confirm(`项目目录已不存在：${s.cwd}\n仍要在当前目录恢复吗？`)) return;
    }
    resumingId = s.id + ':' + kind;
    const popup = window.open('about:blank', '_blank');
    try {
      const created = await api.createSession({
        ...estimateTermSize(),
        cwd: s.cwdExists ? s.cwd : undefined,
        title: (kind === 'safe' ? '🛡 ' : '') + (s.title.length > 38 ? s.title.slice(0, 38) + '…' : s.title),
        initialCommand: command,
      });
      await refreshSessions();
      const url = `${location.pathname}${location.search}#/s/${created.id}`;
      if (popup) popup.location.href = url;
      else navigate({ name: 'terminal', id: created.id });
    } catch (e) {
      error = `恢复失败：${e}`;
      if (popup) popup.close();
    } finally {
      resumingId = null;
    }
  }

  function fmtAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return '刚刚';
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} 分钟前`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return new Date(iso).toLocaleDateString('zh-CN');
  }

  let sourceCounts = $derived.by(() => {
    const c: Record<HistorySource, number> = { 'claude-code': 0, qoder: 0, 'cursor-agent': 0, opencode: 0 };
    for (const s of sessions) c[s.source]++;
    return c;
  });

  let visible = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    return sessions.filter((s) => {
      if (activeSource !== 'all' && s.source !== activeSource) return false;
      if (!q) return true;
      return s.title.toLowerCase().includes(q)
        || s.cwd.toLowerCase().includes(q)
        || s.projectName.toLowerCase().includes(q);
    });
  });

  let groups = $derived.by(() => {
    const byProject = new Map<string, HistorySession[]>();
    // Track each group's latest activity in one pass (avoids re-parsing dates
    // and a Math.max(...spread) per comparison during the sort).
    const lastByProject = new Map<string, number>();
    for (const s of visible) {
      const arr = byProject.get(s.cwd);
      if (arr) arr.push(s);
      else byProject.set(s.cwd, [s]);
      const t = +new Date(s.lastActivityAt);
      const prev = lastByProject.get(s.cwd);
      if (prev === undefined || t > prev) lastByProject.set(s.cwd, t);
    }
    return [...byProject.entries()].sort((a, b) => {
      const aLast = lastByProject.get(a[0]) ?? 0;
      const bLast = lastByProject.get(b[0]) ?? 0;
      if (bLast !== aLast) return bLast - aLast;
      return a[0].localeCompare(b[0]);
    });
  });
</script>

<div class="page" bind:this={pageEl}>
  <header>
    <button class="ghost back" onclick={() => navigate({ name: 'list' })} title="返回会话列表" aria-label="返回">
      <Icon name="arrow-left" size={16} />
    </button>
    <div class="brand">
      <span class="logo"><Icon name="clock" size={16} /></span>
      <div>
        <div class="title">历史会话</div>
        <div class="subtitle">从 AI 工具的历史会话恢复 · 共 {sessions.length} 个</div>
      </div>
    </div>
    <input class="search" placeholder="搜索标题、目录或项目…" bind:value={filterRaw} oninput={onFilterInput} />
    <span class="freshness" title="仅在打开本页、关闭终端标签或手动刷新时更新；浏览时不会自动刷新">
      {fmtFreshness()}
    </span>
    <button
      class="ghost icon-only"
      onclick={() => void refresh(true)}
      title="立即刷新"
      aria-label="立即刷新"
      disabled={refreshing}
    >
      <span class:spinning={refreshing}><Icon name="refresh" size={15} /></span>
    </button>
  </header>

  <div class="source-tabs">
    <button
      class="tab"
      class:active={activeSource === 'all'}
      onclick={() => (activeSource = 'all')}
    >
      全部 <span class="badge">{sessions.length}</span>
    </button>
    {#each (Object.entries(SOURCE_META) as [HistorySource, {label:string,color:string}][]) as [src, meta] (src)}
      <button
        class="tab"
        class:active={activeSource === src}
        onclick={() => (activeSource = src)}
        disabled={sourceCounts[src] === 0}
      >
        <span class="dot" style="background: {meta.color}"></span>
        {meta.label} <span class="badge">{sourceCounts[src]}</span>
      </button>
    {/each}
  </div>

  {#if error}
    <p class="error"><Icon name="alert" size={13} /> {error}</p>
  {/if}

  {#if initialLoading}
    <p class="loading">加载中…</p>
  {:else if sessions.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="folder" size={28} /></span>
      <h3>未发现历史会话</h3>
      <p>没有在 <code>~/.claude</code>、<code>~/.qoder</code>、<code>~/.cursor</code>、<code>~/.local/share/opencode</code> 找到任何记录。</p>
    </div>
  {:else if visible.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="folder" size={28} /></span>
      <h3>没有匹配的会话</h3>
      <p>换个关键词或切换数据源试试。</p>
    </div>
  {:else}
    <div class="groups">
      {#each groups as [cwd, items] (cwd)}
        <section class="group">
          <button
            type="button"
            class="group-head"
            onclick={() => toggleGroup(cwd)}
            aria-expanded={expandedGroups.has(cwd)}
            title={cwd}
          >
            <span class="chev">
              {#if expandedGroups.has(cwd)}
                <Icon name="chevron-down" size={14} />
              {:else}
                <Icon name="chevron-right" size={14} />
              {/if}
            </span>
            <span class="folder"><Icon name="folder" size={13} /></span>
            <span class="cwd">{cwd}</span>
            <span class="count">{items.length}</span>
          </button>
          {#if expandedGroups.has(cwd)}
          <ul>
            {#each items as s (`${s.source}:${s.id}`)}
              {@const meta = SOURCE_META[s.source]}
              <li class="card">
                <div class="card-main">
                  <div class="card-head">
                    <span class="src-chip" style="background: {meta.color}1f; color: {meta.color}">
                      <span class="dot" style="background: {meta.color}"></span>
                      {meta.label}
                    </span>
                    <span class="card-title">{s.title}</span>
                  </div>
                  <div class="meta">
                    <span class="chip" title={s.lastActivityAt}>
                      <Icon name="clock" size={11} /> {fmtAgo(s.lastActivityAt)}
                    </span>
                    {#if s.messageCount}<span class="chip">{s.messageCount} 条消息</span>{/if}
                    {#if s.gitBranch}<span class="chip"><Icon name="git-branch" size={11} /> {s.gitBranch}</span>{/if}
                    {#if !s.cwdExists}
                      <span class="chip chip-warn" title={s.cwd}>
                        <Icon name="alert" size={11} /> 目录不存在
                      </span>
                    {/if}
                    <span class="chip-mono" title="会话 ID">{s.id.slice(0, 10)}</span>
                  </div>
                </div>
                <div class="resume-group">
                  <button
                    class="primary"
                    onclick={() => resume(s, s.resumeCommand, 'plain')}
                    disabled={resumingId !== null && resumingId.startsWith(s.id + ':')}
                    title="新建终端并执行：{s.resumeCommand}"
                  >
                    {#if resumingId === s.id + ':plain'}
                      <Icon name="refresh" size={14} /> 恢复中…
                    {:else}
                      <Icon name="terminal" size={14} /> 恢复
                    {/if}
                  </button>
                  {#if s.safeResumeCommand}
                    <button
                      class="safe"
                      onclick={() => resume(s, s.safeResumeCommand!, 'safe')}
                      disabled={resumingId !== null && resumingId.startsWith(s.id + ':')}
                      title={'在 ai-safe 沙箱中恢复：\n' + s.safeResumeCommand}
                    >
                      {#if resumingId === s.id + ':safe'}
                        <Icon name="refresh" size={14} /> 恢复中…
                      {:else}
                        <Icon name="shield" size={14} /> 安全恢复
                      {/if}
                    </button>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page {
    padding: 28px 24px;
    max-width: 980px;
    margin: 0 auto;
    width: 100%;
    overflow-y: auto;
    flex: 1;
  }
  header {
    display: flex; align-items: center; gap: 10px; margin-bottom: 16px;
  }
  .back { padding: 0; width: 32px; height: 32px; }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .logo {
    display: inline-flex; align-items: center; justify-content: center;
    width: 32px; height: 32px; background: var(--accent-soft); color: var(--accent);
    border-radius: var(--radius-sm);
  }
  .title { font-weight: 600; font-size: 17px; letter-spacing: -0.01em; }
  .subtitle { color: var(--fg-muted); font-size: 12px; margin-top: 1px; }
  .search { margin-left: auto; min-width: 240px; max-width: 340px; flex-shrink: 1; }
  .freshness {
    color: var(--fg-muted);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    user-select: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spinning { display: inline-flex; animation: spin 1s linear infinite; }

  .source-tabs {
    display: flex; gap: 6px; flex-wrap: wrap;
    padding: 8px 4px 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 18px;
  }
  .tab {
    display: inline-flex; align-items: center; gap: 6px;
    background: transparent; border: 1px solid transparent;
    padding: 4px 12px; height: 30px;
    font-size: 12.5px; font-weight: 500;
    color: var(--fg-muted);
    border-radius: 999px;
    cursor: pointer;
  }
  .tab:hover:not(:disabled) { background: var(--bg-hover); color: var(--fg); }
  .tab.active { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
  .tab .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .tab .badge {
    background: color-mix(in srgb, var(--fg) 10%, transparent);
    border-radius: 999px; padding: 0 7px;
    font-size: 11px; font-weight: 600;
    color: inherit;
  }

  .error {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--danger); background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-sm);
    padding: 8px 12px; margin: 0 0 16px; font-size: 13px;
  }
  .loading { color: var(--fg-muted); font-size: 13px; }

  .empty {
    display: flex; flex-direction: column; align-items: center;
    text-align: center; padding: 64px 24px; color: var(--fg-muted);
  }
  .empty-icon {
    display: inline-flex; align-items: center; justify-content: center;
    width: 60px; height: 60px; margin-bottom: 16px;
    background: var(--bg-hover); border-radius: 50%;
  }
  .empty h3 { margin: 0 0 6px; color: var(--fg); font-weight: 600; font-size: 15px; }
  .empty p { margin: 0; font-size: 13px; max-width: 480px; }
  .empty code {
    background: var(--bg-hover); padding: 1px 6px; border-radius: 4px;
    font-size: 12px;
  }

  .groups { display: flex; flex-direction: column; gap: 8px; }
  .group { display: flex; flex-direction: column; gap: 6px; }
  .group-head {
    display: flex; align-items: center; gap: 8px;
    width: 100%;
    font-size: 12px; color: var(--fg-muted); font-weight: 500;
    padding: 8px 10px;
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--bg-elev);
    cursor: pointer;
    font: inherit;
    text-align: left;
  }
  .group-head:hover { background: var(--bg-hover); border-color: var(--border-strong); }
  .group-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .chev {
    display: inline-flex; align-items: center; justify-content: center;
    width: 14px; flex-shrink: 0; color: var(--fg-muted);
  }
  .folder { color: var(--accent); display: inline-flex; flex-shrink: 0; }
  .cwd {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    color: var(--fg); flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .count {
    background: var(--bg-hover); color: var(--fg-muted);
    border-radius: 999px; padding: 0 8px;
    font-size: 11px; font-weight: 600;
    flex-shrink: 0;
  }

  ul { list-style: none; padding: 0 0 0 4px; margin: 0; display: flex; flex-direction: column; gap: 6px; }
  .card {
    display: flex; align-items: stretch; gap: 12px;
    background: var(--bg-elev); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 12px 14px;
    transition: border-color 80ms ease, box-shadow 80ms ease;
  }
  .card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
  .card-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
  .card-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .src-chip {
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; font-weight: 600;
    padding: 2px 8px; border-radius: 4px;
    flex-shrink: 0;
  }
  .src-chip .dot { width: 6px; height: 6px; border-radius: 50%; }
  .card-title {
    font-weight: 500; font-size: 14px; color: var(--fg);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0; flex: 1;
  }
  .meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg-hover); color: var(--fg-muted);
    border-radius: 999px; padding: 2px 9px;
    font-size: 11.5px; line-height: 1.5;
  }
  .chip-warn { background: var(--warning-soft); color: var(--warning); }
  .chip-mono {
    background: var(--bg-hover); color: var(--fg-muted);
    border-radius: 4px; padding: 1px 6px;
    font-size: 11px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
  }

  .resume-group {
    display: flex; flex-direction: column; gap: 6px;
    flex-shrink: 0;
  }
  button.safe {
    background: var(--success-soft);
    border-color: color-mix(in srgb, var(--success) 35%, transparent);
    color: var(--success);
    font-weight: 500;
  }
  button.safe:hover:not(:disabled) {
    background: color-mix(in srgb, var(--success) 22%, var(--bg-elev));
    border-color: var(--success);
  }
</style>

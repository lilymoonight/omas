<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { sessions, startSessionPolling, stopSessionPolling, refreshSessions, checkAuth } from '../lib/stores.js';
  import { api, apiBase } from '../lib/api.js';
  import { refreshHistoryAfterSessionClose } from '../lib/history-cache.js';
  import { navigate } from '../lib/router.js';
  import { estimateTermSize } from '../lib/term-size.js';
  import Icon from '../components/Icon.svelte';
  import SystemPanel from '../components/SystemPanel.svelte';

  let creating = $state(false);
  let error = $state<string | null>(null);
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');

  onMount(() => startSessionPolling());
  onDestroy(() => stopSessionPolling());

  async function createSession() {
    creating = true;
    error = null;
    // Open the popup synchronously inside the user gesture so popup blockers
    // are happy; we then redirect it after the POST returns the session id.
    const popup = window.open('about:blank', '_blank');
    try {
      const s = await api.createSession({ ...estimateTermSize(), });
      await refreshSessions();
      const url = `${location.pathname}${location.search}#/s/${s.id}`;
      if (popup) popup.location.href = url;
      else navigate({ name: 'terminal', id: s.id }); // popup blocked: fall back
    } catch (e) {
      error = `创建失败：${e}`;
      if (popup) popup.close();
    } finally {
      creating = false;
    }
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
    <button class="ghost" title="从 Claude 等工具历史中恢复" onclick={() => navigate({ name: 'history' })}>
      <Icon name="clock" size={16} />
      <span>历史</span>
    </button>
    <button class="ghost" title="退出登录" aria-label="退出登录" onclick={logout}>
      <Icon name="log-out" size={16} />
      <span>退出</span>
    </button>
    <button class="primary" onclick={createSession} disabled={creating}>
      {#if creating}
        <Icon name="refresh" size={14} />
        创建中…
      {:else}
        <Icon name="plus" size={14} />
        新建会话
      {/if}
    </button>
  </header>

  {#if error}
    <p class="error"><Icon name="alert" size={14} /> {error}</p>
  {/if}

  {#if $sessions.length === 0}
    <div class="empty">
      <span class="empty-icon"><Icon name="monitor" size={28} /></span>
      <h3>暂无会话</h3>
      <p>点击右上角「新建会话」开启第一个终端。</p>
    </div>
  {:else}
    <ul class="grid">
      {#each $sessions as s (s.id)}
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
            </div>
            <div class="meta">
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

  .error {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid #f6c4ca;
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

  .grid { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }

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

  .actions {
    display: flex; align-items: center; gap: 4px;
    padding: 0 10px;
    border-left: 1px solid var(--border);
  }
</style>

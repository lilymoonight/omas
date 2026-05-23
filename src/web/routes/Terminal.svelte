<script lang="ts">
  import { onMount } from 'svelte';
  import XTerm from '../components/XTerm.svelte';
  import FilesPanel from '../components/FilesPanel.svelte';
  import GitPanel from '../components/GitPanel.svelte';
  import { api } from '../lib/api.js';
  import { refreshHistoryAfterSessionClose } from '../lib/history-cache.js';
  import { navigate } from '../lib/router.js';
  import type { Session } from '../../shared/session.js';
  import Icon from '../components/Icon.svelte';

  interface Props { sessionId: string; }
  const { sessionId }: Props = $props();

  let session = $state<Session | null>(null);
  let status = $state<'connecting' | 'open' | 'closed'>('connecting');
  let clientCount = $state(1);
  let exitInfo = $state<{ code: number | null; signal: string | null } | null>(null);
  let notFound = $state(false);
  let title = $state<string>('终端');

  const STATUS_LABEL: Record<'connecting' | 'open' | 'closed', string> = {
    connecting: '连接中',
    open: '已连接',
    closed: '已断开',
  };

  onMount(async () => {
    try {
      const s = await api.getSession(sessionId);
      session = s;
      title = s.title;
    } catch (e) {
      if (String(e).includes('404')) notFound = true;
    }
  });

  async function destroy() {
    if (!confirm(`确认销毁会话「${title}」？`)) return;
    try { await api.deleteSession(sessionId); } catch { /* */ }
    closeOrNavigate();
  }

  // This tab is meant to be ephemeral — close it when the user is done. If the
  // browser refuses window.close() (it does so when the tab wasn't script-opened
  // by us, e.g. user typed the URL directly), fall back to in-tab navigate so
  // there's always *some* way out.
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
    <span class="title-icon"><Icon name="terminal" size={14} /></span>
    <span class="title">{title}</span>

    <div class="spacer"></div>

    <span class="status status-{status}" title={STATUS_LABEL[status]}>
      <span class="dot"><Icon name="circle" size={8} /></span>
      <span>{STATUS_LABEL[status]}</span>
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
        已退出（{exitInfo.code ?? exitInfo.signal}）
      </span>
    {/if}

    <button class="ghost icon-only danger" onclick={destroy} title="销毁会话" aria-label="销毁会话">
      <Icon name="trash" size={15} />
    </button>
  </header>
  <div class="body">
    {#if session}
      <FilesPanel {sessionId} />
    {/if}
    <div class="term">
      {#if notFound}
        <div class="empty">
          <Icon name="alert" size={22} />
          <p>会话不存在，可能已经被销毁。</p>
          <button class="primary" onclick={closeOrNavigate}>关闭</button>
        </div>
      {:else if session}
        <XTerm
          {sessionId}
          onTitle={(t) => (title = t)}
          onClientCount={(n) => (clientCount = n)}
          onExit={(info) => (exitInfo = info)}
          onStatus={(s) => (status = s)}
        />
      {/if}
    </div>
    {#if session}
      <GitPanel {sessionId} />
    {/if}
  </div>
</div>

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
  .title-icon { color: var(--accent); display: inline-flex; }
  .title { font-weight: 600; color: var(--fg); }
  .spacer { flex: 1; }

  .status {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 500;
  }
  .status .dot { display: inline-flex; }
  .status-connecting { background: #fff8e1; color: #946800; }
  .status-open { background: #e6f4ea; color: var(--success); }
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
  }
  .term {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 10px;
    background: var(--bg-soft);
    display: flex;
  }
  .term :global(.xterm-host) {
    background: #ffffff;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
    /* No padding here — FitAddon reads the *parent* of `.xterm` (= this host)
       and would mis-measure if padding lived here. Inner breathing room goes
       on `.xterm` below, which FitAddon explicitly subtracts. */
  }
  .term :global(.xterm) {
    /* This padding is honored by FitAddon (it reads padding on the .xterm
       element via getComputedStyle), so cols/rows still calculate cleanly. */
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
</style>

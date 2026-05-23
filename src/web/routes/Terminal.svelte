<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import XTerm from '../components/XTerm.svelte';
  import FilesPanel from '../components/FilesPanel.svelte';
  import GitPanel from '../components/GitPanel.svelte';
  import { api } from '../lib/api.js';
  import { refreshHistoryAfterSessionClose } from '../lib/history-cache.js';
  import { navigate } from '../lib/router.js';
  import { NARROW_BREAKPOINT } from '../lib/term-layout.js';
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
  let isNarrow = $state(false);
  let drawerLeft = $state(false);
  let drawerRight = $state(false);

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
        <FilesPanel {sessionId} />
      </div>
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
      <div class="side-slot right">
        <GitPanel {sessionId} />
      </div>
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
  .drawer-toggle.active { background: var(--accent-soft); color: var(--accent); }
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
  }
  .term :global(.xterm-host) {
    background: #ffffff;
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

<script lang="ts">
  import { onMount } from 'svelte';
  import XTerm from '../components/XTerm.svelte';
  import { api } from '../lib/api.js';
  import { themePref, cycleTheme, THEME_LABEL } from '../lib/theme.js';
  import Icon from '../components/Icon.svelte';

  interface Props { token: string; }
  const { token }: Props = $props();

  let title = $state('共享终端');
  let status = $state<'connecting' | 'open' | 'closed'>('connecting');
  let exitInfo = $state<{ code: number | null; signal: string | null } | null>(null);
  let invalid = $state(false);
  let ready = $state(false);

  const STATUS_LABEL: Record<'connecting' | 'open' | 'closed', string> = {
    connecting: '连接中',
    open: '已连接',
    closed: '已断开',
  };

  onMount(async () => {
    try {
      const meta = await api.sharedMeta(token);
      title = meta.title;
      ready = true;
    } catch {
      invalid = true;
    }
  });
</script>

<div class="wrap">
  <header>
    <span class="title-icon"><Icon name="terminal" size={14} /></span>
    <span class="title">{title}</span>
    <span class="readonly" title="只读模式：无法输入或改变窗口大小">
      <Icon name="eye-off" size={12} /> 只读
    </span>

    <div class="spacer"></div>

    {#if ready && !invalid}
      <span class="status status-{status}" title={STATUS_LABEL[status]}>
        <span class="dot"><Icon name="circle" size={8} /></span>
        <span class="status-text">{STATUS_LABEL[status]}</span>
      </span>
    {/if}

    {#if exitInfo}
      <span class="exited" title="shell 已退出">
        <Icon name="eye-off" size={13} />
        已退出（{exitInfo.code ?? exitInfo.signal}）
      </span>
    {/if}

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
  </header>

  <div class="body">
    {#if invalid}
      <div class="empty">
        <Icon name="alert" size={22} />
        <p>分享链接无效或已过期。</p>
        <p class="hint">服务重启后旧的分享链接会失效，请向会话所有者索取新链接。</p>
      </div>
    {:else if ready}
      <div class="term">
        <XTerm
          sessionId=""
          shareToken={token}
          {title}
          onTitle={(t) => (title = t)}
          onExit={(info) => (exitInfo = info)}
          onStatus={(s) => (status = s)}
        />
      </div>
    {:else}
      <div class="empty"><p>加载中…</p></div>
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
  .title-icon { color: var(--accent); display: inline-flex; }
  .title {
    font-weight: 600; color: var(--fg);
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .readonly {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--bg-hover); color: var(--fg-muted);
    border-radius: 999px; padding: 3px 9px;
    font-size: 11px; font-weight: 600; flex-shrink: 0;
  }
  .spacer { flex: 1; }
  .status {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 500;
  }
  .status .dot { display: inline-flex; }
  .status-connecting { background: var(--warning-soft); color: var(--warning); }
  .status-open { background: var(--success-soft); color: var(--success); }
  .status-closed { background: var(--danger-soft); color: var(--danger); }
  .exited {
    display: inline-flex; align-items: center; gap: 6px;
    color: var(--danger); background: var(--danger-soft);
    border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 500;
  }
  .body { flex: 1; min-height: 0; display: flex; }
  /* The viewer keeps the session's native width (never reflows). The terminal box
     sizes to that content width and is centered via auto margins; when the viewer
     window is narrower than the session, the margins collapse and the area scrolls
     horizontally (left edge stays reachable — unlike flex `justify-content:center`,
     which would clip the overflowing left side out of scroll range). */
  .term {
    flex: 1;
    min-width: 0;
    min-height: 0;
    padding: 10px;
    display: block;
    overflow: auto;
    position: relative;
  }
  .term :global(.xterm-shell) {
    width: -moz-fit-content;
    width: fit-content;
    height: 100%;
    margin: 0 auto;
  }
  .term :global(.xterm-host) {
    width: auto;
    background: var(--term-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .term :global(.xterm) { padding: 6px 12px; box-sizing: border-box; height: 100%; }
  .empty {
    flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; color: var(--fg-muted); text-align: center; padding: 24px;
  }
  .empty p { margin: 0; font-size: 14px; }
  .empty .hint { font-size: 12.5px; max-width: 420px; }
</style>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { sessions, refreshSessions, checkAuth } from '../lib/stores.js';
  import { api, apiBase } from '../lib/api.js';
  import { navigate } from '../lib/router.js';
  import { cycleTheme } from '../lib/theme.js';
  import {
    notifyPref,
    enableNotifications,
    disableNotifications,
    notificationsSupported,
  } from '../lib/notifications.js';
  import { estimateTermSize } from '../lib/term-size.js';
  import Icon from './Icon.svelte';

  type CmdIcon = 'plus' | 'terminal' | 'clock' | 'globe' | 'sun' | 'bell' | 'bell-off' | 'log-out';
  type Cmd = {
    id: string;
    label: string;
    hint?: string;
    icon: CmdIcon;
    keywords?: string;
    run: () => void;
  };

  let open = $state(false);
  let query = $state('');
  let active = $state(0);
  let input = $state<HTMLInputElement | null>(null);

  const notifySupported = notificationsSupported();

  function close() {
    open = false;
    query = '';
    active = 0;
  }

  function openPalette() {
    open = true;
    query = '';
    active = 0;
    void refreshSessions();
    requestAnimationFrame(() => input?.focus());
  }

  function toggle() {
    if (open) close();
    else openPalette();
  }

  function openSessionTab(id: string) {
    const url = `${location.pathname}${location.search}#/s/${id}`;
    window.open(url, '_blank', 'noopener');
  }

  async function newSession() {
    const popup = window.open('about:blank', '_blank');
    try {
      const s = await api.createSession({ ...estimateTermSize() });
      await refreshSessions();
      const url = `${location.pathname}${location.search}#/s/${s.id}`;
      if (popup) popup.location.href = url;
      else navigate({ name: 'terminal', id: s.id });
    } catch (e) {
      if (popup) popup.close();
      alert(`创建失败：${e}`);
    }
  }

  async function logout() {
    await fetch(apiBase + 'auth/logout', { method: 'POST', credentials: 'same-origin' });
    await checkAuth();
  }

  async function toggleNotify() {
    if ($notifyPref === 'on') disableNotifications();
    else await enableNotifications();
  }

  const actions = $derived<Cmd[]>([
    { id: 'new', label: '新建会话', icon: 'plus', keywords: 'new session create terminal 新建', run: () => { close(); void newSession(); } },
    { id: 'list', label: '会话列表', icon: 'terminal', keywords: 'home sessions list 列表 主页', run: () => { close(); navigate({ name: 'list' }); } },
    { id: 'history', label: '历史记录', icon: 'clock', keywords: 'history claude cursor resume 历史 恢复', run: () => { close(); navigate({ name: 'history' }); } },
    { id: 'publish', label: '公开站点 / 发布', icon: 'globe', keywords: 'publish sites static 发布 站点', run: () => { close(); navigate({ name: 'publish' }); } },
    { id: 'theme', label: '切换主题', icon: 'sun', keywords: 'theme dark light 主题 深色 浅色', run: () => { cycleTheme(); } },
    ...(notifySupported
      ? [{
          id: 'notify',
          label: $notifyPref === 'on' ? '关闭 Agent 空闲通知' : '开启 Agent 空闲通知',
          icon: ($notifyPref === 'on' ? 'bell-off' : 'bell') as CmdIcon,
          keywords: 'notify notification agent idle 通知',
          run: () => { void toggleNotify(); },
        } satisfies Cmd]
      : []),
    { id: 'logout', label: '退出登录', icon: 'log-out', keywords: 'logout sign out 退出 登出', run: () => { close(); void logout(); } },
  ]);

  const sessionCmds = $derived<Cmd[]>(
    $sessions.map((s) => ({
      id: `s:${s.id}`,
      label: s.title,
      hint: (s.liveCwd ?? s.cwd) ?? undefined,
      icon: 'terminal' as const,
      keywords: `${s.title} ${(s.liveCwd ?? s.cwd) ?? ''} ${s.agent ?? ''}`,
      run: () => { close(); openSessionTab(s.id); },
    })),
  );

  /** Case-insensitive subsequence match; returns true when every query char appears in order. */
  function matches(haystack: string, q: string): boolean {
    if (!q) return true;
    const h = haystack.toLowerCase();
    let i = 0;
    for (const ch of q.toLowerCase()) {
      i = h.indexOf(ch, i);
      if (i === -1) return false;
      i++;
    }
    return true;
  }

  const filtered = $derived.by(() => {
    const q = query.trim();
    const all = [...actions, ...sessionCmds];
    if (!q) return all;
    return all.filter((c) => matches(`${c.label} ${c.hint ?? ''} ${c.keywords ?? ''}`, q));
  });

  $effect(() => {
    // Keep the active index in range as the filtered list changes.
    if (active >= filtered.length) active = Math.max(0, filtered.length - 1);
  });

  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      toggle();
    }
  }

  function onListKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, filtered.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[active]?.run();
    }
  }

  const openEvent = () => openPalette();
  onMount(() => {
    window.addEventListener('keydown', onKey);
    window.addEventListener('omas:command-palette', openEvent);
  });
  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('omas:command-palette', openEvent);
  });
</script>

{#if open}
  <div class="overlay" role="presentation" onclick={close}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="palette" role="dialog" tabindex="-1" aria-label="命令面板" onclick={(e) => e.stopPropagation()} onkeydown={onListKey}>
      <div class="search">
        <Icon name="search" size={16} />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          bind:this={input}
          bind:value={query}
          class="search-input"
          type="text"
          placeholder="搜索会话或命令…"
          spellcheck="false"
          autocomplete="off"
          autofocus
        />
        <kbd>esc</kbd>
      </div>
      <ul class="results">
        {#if filtered.length === 0}
          <li class="no-results">无匹配项</li>
        {:else}
          {#each filtered as cmd, i (cmd.id)}
            <li>
              <button
                class="result"
                class:active={i === active}
                onmousemove={() => (active = i)}
                onclick={cmd.run}
              >
                <span class="r-icon"><Icon name={cmd.icon} size={15} /></span>
                <span class="r-label">{cmd.label}</span>
                {#if cmd.hint}<span class="r-hint">{cmd.hint}</span>{/if}
              </button>
            </li>
          {/each}
        {/if}
      </ul>
      <div class="foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 执行</span>
        <span><kbd>⌘</kbd><kbd>K</kbd> 开/关</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: rgba(15, 23, 42, 0.4);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 12vh 16px 16px;
    backdrop-filter: blur(2px);
  }
  .palette {
    width: min(560px, 100%);
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-md);
    overflow: hidden;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 14px;
    border-bottom: 1px solid var(--border);
    color: var(--fg-muted);
  }
  .search-input {
    flex: 1;
    border: none;
    background: transparent;
    color: var(--fg);
    font-size: 15px;
    outline: none;
  }
  .search-input::placeholder { color: var(--fg-muted); }
  .results { list-style: none; margin: 0; padding: 6px; overflow-y: auto; flex: 1; }
  .no-results { padding: 18px; text-align: center; color: var(--fg-muted); font-size: 13px; }
  .result {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 9px 10px;
    border: none;
    background: transparent;
    border-radius: var(--radius-sm);
    color: var(--fg);
    font-size: 13.5px;
    text-align: left;
    cursor: pointer;
  }
  .result.active { background: var(--accent-soft); }
  .r-icon { display: inline-flex; color: var(--fg-muted); flex-shrink: 0; }
  .result.active .r-icon { color: var(--accent); }
  .r-label { flex-shrink: 0; font-weight: 500; }
  .r-hint {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: right;
    color: var(--fg-muted);
    font-family: var(--mono, monospace);
    font-size: 11.5px;
  }
  .foot {
    display: flex;
    gap: 16px;
    padding: 8px 14px;
    border-top: 1px solid var(--border);
    color: var(--fg-muted);
    font-size: 11px;
  }
  .foot span { display: inline-flex; align-items: center; gap: 4px; }
  kbd {
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    background: var(--bg-hover);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 5px;
    color: var(--fg-muted);
  }
</style>

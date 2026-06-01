<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { api, type RuntimeInfo, type DirEntry } from '../lib/api.js';
  import { refreshSessions } from '../lib/stores.js';
  import { navigate } from '../lib/router.js';
  import { estimateTermSize } from '../lib/term-size.js';
  import Icon from './Icon.svelte';

  interface Props {
    /** Pre-fill the directory (e.g. "new session in this folder" from the tree). */
    initialCwd?: string;
    onClose: () => void;
  }
  const { initialCwd, onClose }: Props = $props();

  const LAST_CWD_KEY = 'omas-last-cwd';

  let runtime = $state<RuntimeInfo | null>(null);
  let cwd = $state('');
  let sandbox = $state(true);
  let bypass = $state('');
  let creating = $state(false);
  let error = $state<string | null>(null);

  // Directory browser (breadcrumb path + inline child list)
  let children = $state<DirEntry[]>([]);
  let loading = $state(false);
  let listTimer: ReturnType<typeof setTimeout> | null = null;
  let listSeq = 0;
  let cwdInput: HTMLInputElement | null = $state(null);

  const sandboxOn = $derived(runtime?.sandbox.enabled === true);
  const bypassAvailable = $derived(
    runtime?.sandbox.enabled === true && runtime.sandbox.bypassAvailable === true,
  );
  // When sandboxed, don't let the breadcrumb climb above the writable ceiling.
  const clampRoot = $derived(runtime?.sandbox.enabled ? runtime.sandbox.root : null);
  const crumbs = $derived(buildCrumbs(cwd, clampRoot));
  const canUp = $derived(crumbs.length > 1);

  onMount(async () => {
    try {
      runtime = await api.runtime();
    } catch {
      runtime = { defaultCwd: '', sandbox: { enabled: false } };
    }
    let last = '';
    try {
      last = localStorage.getItem(LAST_CWD_KEY) ?? '';
    } catch {
      /* ignore */
    }
    cwd = initialCwd || last || runtime.defaultCwd || '';
    if (runtime.sandbox.enabled) sandbox = runtime.sandbox.defaultOn;
    void refreshNow();
    await tick();
    cwdInput?.focus();
  });

  /** Split an absolute path into clickable breadcrumb segments, clamped so it
   *  never climbs above the sandbox root when one is configured. */
  function buildCrumbs(dir: string, clamp: string | null): { label: string; path: string }[] {
    if (!dir || !dir.startsWith('/')) return [];
    const norm = dir.replace(/\/+$/, '') || '/';
    const parts = norm.split('/');
    const out: { label: string; path: string }[] = [];
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) {
        out.push({ label: '/', path: '/' });
        continue;
      }
      const seg = parts[i];
      if (!seg) continue;
      acc += '/' + seg;
      out.push({ label: seg, path: acc });
    }
    if (clamp) {
      const c = clamp.replace(/\/+$/, '');
      const idx = out.findIndex((x) => x.path === c);
      if (idx > 0) return out.slice(idx);
    }
    return out;
  }

  function parentOf(dir: string): string {
    const norm = dir.replace(/\/+$/, '');
    const i = norm.lastIndexOf('/');
    return i <= 0 ? '/' : norm.slice(0, i);
  }

  /** List the children of the current `cwd`. Latest call wins (seq guard). */
  async function refreshNow() {
    if (listTimer) {
      clearTimeout(listTimer);
      listTimer = null;
    }
    const seq = ++listSeq;
    loading = true;
    try {
      const r = await api.listDirs(cwd);
      if (seq !== listSeq) return;
      children = r.entries;
    } catch {
      if (seq === listSeq) children = [];
    } finally {
      if (seq === listSeq) loading = false;
    }
  }

  function refreshDebounced() {
    if (listTimer) clearTimeout(listTimer);
    listTimer = setTimeout(() => void refreshNow(), 160);
  }

  function onCwdInput() {
    error = null;
    refreshDebounced();
  }

  function enter(e: DirEntry) {
    cwd = e.path;
    void refreshNow();
    cwdInput?.focus();
  }

  function goCrumb(path: string) {
    if (path === cwd.replace(/\/+$/, '')) return;
    cwd = path;
    void refreshNow();
  }

  function up() {
    if (!canUp) return;
    cwd = parentOf(cwd);
    void refreshNow();
  }

  function onCwdKeydown(ev: KeyboardEvent) {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void submit();
    }
  }

  function friendlyError(msg: string): string {
    if (msg.includes('cwd_outside_sandbox_root')) {
      const root = runtime?.sandbox.enabled ? runtime.sandbox.root : '';
      return `工作目录必须在沙箱根目录内：${root}`;
    }
    if (msg.includes('unsandboxed_disabled')) return '未配置解除沙箱口令，无法创建非沙箱会话（请先运行 omas passwd --bypass）。';
    if (msg.includes('bad_bypass')) return '解除沙箱口令错误。';
    if (msg.includes('too_many_attempts') || msg.includes('429')) return '尝试次数过多，请稍后再试。';
    return `创建失败：${msg}`;
  }

  async function submit() {
    if (creating) return;
    if (!cwd.trim()) {
      error = '请填写工作目录';
      return;
    }
    if (sandboxOn && !sandbox && bypassAvailable && !bypass) {
      error = '创建非沙箱会话需要填写解除沙箱口令';
      return;
    }
    creating = true;
    error = null;
    // Open the popup synchronously within the click gesture (popup-blocker safe).
    const popup = window.open('about:blank', '_blank');
    try {
      const s = await api.createSession({
        ...estimateTermSize(),
        cwd: cwd.trim(),
        ...(sandboxOn ? { sandbox } : {}),
        ...(sandboxOn && !sandbox ? { bypass } : {}),
      });
      try {
        localStorage.setItem(LAST_CWD_KEY, cwd.trim());
      } catch {
        /* ignore */
      }
      await refreshSessions();
      const url = `${location.pathname}${location.search}#/s/${s.id}`;
      if (popup) popup.location.href = url;
      else navigate({ name: 'terminal', id: s.id });
      onClose();
    } catch (e) {
      if (popup) popup.close();
      error = friendlyError(String(e));
    } finally {
      creating = false;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="overlay" onclick={onClose}>
  <div class="dialog" role="dialog" tabindex="-1" aria-modal="true" aria-label="新建会话" onclick={(e) => e.stopPropagation()}>
    <header class="head">
      <span class="head-icon"><Icon name="terminal" size={16} /></span>
      <span class="head-title">新建会话</span>
      <button class="x" aria-label="关闭" onclick={onClose}><Icon name="x" size={16} /></button>
    </header>

    <div class="body">
      <div class="field">
        <span class="label">工作目录</span>
        <div class="cwd-wrap">
          <span class="cwd-icon"><Icon name="folder" size={14} /></span>
          <input
            bind:this={cwdInput}
            class="cwd-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="/path/to/project"
            bind:value={cwd}
            oninput={onCwdInput}
            onkeydown={onCwdKeydown}
          />
        </div>

        <nav class="crumbs" aria-label="目录路径">
          {#each crumbs as c, i (c.path)}
            <button
              type="button"
              class="crumb"
              class:current={i === crumbs.length - 1}
              onclick={() => goCrumb(c.path)}
              title={c.path}
            >{c.label}</button>
            {#if i < crumbs.length - 1}
              <span class="crumb-sep"><Icon name="chevron-right" size={12} /></span>
            {/if}
          {/each}
        </nav>

        <div class="dir-list">
          {#if canUp}
            <button type="button" class="dir-item up" onclick={up}>
              <span class="dir-ico"><Icon name="arrow-up" size={14} /></span>
              <span class="dir-name">上级目录</span>
            </button>
          {/if}
          {#each children as e (e.path)}
            <button type="button" class="dir-item" onclick={() => enter(e)} title={e.path}>
              <span class="dir-ico"><Icon name="folder" size={14} /></span>
              <span class="dir-name">{e.name}</span>
              <span class="dir-enter"><Icon name="chevron-right" size={14} /></span>
            </button>
          {/each}
          {#if loading && children.length === 0}
            <p class="dir-empty">载入中…</p>
          {:else if children.length === 0}
            <p class="dir-empty">没有子目录——会话将在此目录创建</p>
          {/if}
        </div>
      </div>

      {#if sandboxOn}
        <label class="check">
          <input type="checkbox" bind:checked={sandbox} />
          <span class="check-body">
            <span class="check-title">
              <Icon name="shield" size={13} /> 沙箱隔离
            </span>
            <span class="check-hint">
              文件系统只读，仅<b>工作目录</b>可写。{runtime?.sandbox.enabled
                ? `（可写区必须在 ${runtime.sandbox.root} 内）`
                : ''}
            </span>
          </span>
        </label>

        {#if !sandbox}
          {#if bypassAvailable}
            <label class="field">
              <span class="label">解除沙箱口令</span>
              <input
                class="text-input"
                type="password"
                autocomplete="off"
                placeholder="创建全盘可写会话需校验"
                bind:value={bypass}
                onkeydown={(e) => { if (e.key === 'Enter') void submit(); }}
              />
              <span class="sub-hint">这是独立于登录密码的口令，agent 不应知道。</span>
            </label>
          {:else}
            <p class="warn">
              <Icon name="alert" size={13} />
              未配置解除沙箱口令，无法创建非沙箱会话。请在服务器运行 <code>omas passwd --bypass</code>。
            </p>
          {/if}
        {/if}
      {/if}

      {#if error}
        <p class="error"><Icon name="alert" size={13} /> {error}</p>
      {/if}
    </div>

    <footer class="foot">
      <button class="ghost" onclick={onClose}>取消</button>
      <button
        class="primary"
        onclick={submit}
        disabled={creating || (sandboxOn && !sandbox && !bypassAvailable)}
      >
        {#if creating}
          <Icon name="refresh" size={14} /> 创建中…
        {:else}
          <Icon name="plus" size={14} /> 创建
        {/if}
      </button>
    </footer>
  </div>
</div>

<style>
  .overlay {
    position: fixed; inset: 0;
    background: color-mix(in srgb, #000 45%, transparent);
    display: flex; align-items: flex-start; justify-content: center;
    padding-top: 12vh;
    z-index: 1000;
  }
  .dialog {
    width: min(680px, calc(100vw - 32px));
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-lg, 0 20px 50px rgba(0,0,0,0.35));
    display: flex; flex-direction: column;
    /* visible so the directory dropdown can extend past the dialog edge instead
       of being clipped (head/foot have no corner fills, so radius still reads). */
    overflow: visible;
  }
  .head {
    display: flex; align-items: center; gap: 9px;
    padding: 13px 14px;
    border-bottom: 1px solid var(--border);
  }
  .head-icon { color: var(--accent); display: inline-flex; }
  .head-title { font-weight: 600; font-size: 14px; flex: 1; }
  .x {
    border: none; background: none; cursor: pointer; color: var(--fg-muted);
    display: inline-flex; padding: 4px; border-radius: var(--radius-sm);
  }
  .x:hover { background: var(--bg-hover); color: var(--fg); }

  .body { padding: 16px 14px; display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .label { font-size: 12px; font-weight: 600; color: var(--fg); }
  .sub-hint { font-size: 11px; color: var(--fg-muted); }

  .cwd-wrap { position: relative; display: flex; align-items: center; }
  .cwd-icon {
    position: absolute; left: 10px; color: var(--fg-muted);
    display: inline-flex; pointer-events: none;
  }
  .cwd-input, .text-input {
    width: 100%;
    box-sizing: border-box;
    padding: 9px 11px;
    font-size: 13px;
    font-family: var(--mono, monospace);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--fg);
  }
  .cwd-input { padding-left: 30px; }
  .cwd-input:focus, .text-input:focus { outline: none; border-color: var(--accent); }

  /* Breadcrumb path: clickable ancestor segments. */
  .crumbs {
    display: flex; align-items: center; flex-wrap: wrap; gap: 1px;
    padding: 2px 0;
    font-family: var(--mono, monospace);
  }
  .crumb {
    border: none; background: none; cursor: pointer;
    padding: 2px 6px; border-radius: var(--radius-sm);
    font-family: inherit; font-size: 12px;
    color: var(--fg-muted);
    max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .crumb:hover { background: var(--bg-hover); color: var(--fg); }
  .crumb.current { color: var(--accent); font-weight: 600; }
  .crumb-sep { display: inline-flex; color: var(--fg-muted); opacity: 0.6; }

  /* Inline child-directory list (always visible — no clipping). */
  .dir-list {
    max-height: min(340px, 46vh); overflow-y: auto;
    display: flex; flex-direction: column; gap: 1px;
    padding: 4px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .dir-item {
    display: flex; align-items: center; gap: 8px;
    width: 100%; box-sizing: border-box;
    padding: 7px 9px; margin: 0;
    border: none; background: none; cursor: pointer; text-align: left;
    border-radius: var(--radius-sm);
    font-family: var(--mono, monospace);
    font-size: 13px;
    color: var(--fg);
  }
  .dir-item:hover, .dir-item:focus-visible { background: var(--bg-hover); outline: none; }
  .dir-ico { display: inline-flex; color: var(--fg-muted); flex-shrink: 0; }
  .dir-item.up .dir-ico { color: var(--accent); }
  .dir-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dir-enter { display: inline-flex; color: var(--fg-muted); opacity: 0; flex-shrink: 0; }
  .dir-item:hover .dir-enter, .dir-item:focus-visible .dir-enter { opacity: 0.7; }
  .dir-empty {
    margin: 0; padding: 10px 9px;
    font-size: 12px; color: var(--fg-muted);
  }

  .check { display: flex; align-items: flex-start; gap: 9px; cursor: pointer; }
  .check input { margin-top: 2px; }
  .check-body { display: flex; flex-direction: column; gap: 2px; }
  .check-title {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 13px; font-weight: 600; color: var(--fg);
  }
  .check-title :global(svg) { color: var(--accent); }
  .check-hint { font-size: 11.5px; color: var(--fg-muted); }
  .check-hint b { color: var(--fg); font-weight: 600; }

  .warn, .error {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    margin: 0;
  }
  .warn { color: var(--fg-muted); background: var(--bg-hover); }
  .warn code { font-family: var(--mono, monospace); color: var(--fg); }
  .error {
    color: var(--danger);
    background: var(--danger-soft);
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  }

  .foot {
    display: flex; justify-content: flex-end; gap: 8px;
    padding: 12px 14px;
    border-top: 1px solid var(--border);
  }
</style>

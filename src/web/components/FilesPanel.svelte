<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api, type FsEntry } from '../lib/api.js';
  import { fsEntriesEqual } from '../lib/stable-update.js';
  import Icon from './Icon.svelte';
  import type { Component } from 'svelte';

  let EditorModal = $state<Component<{
    sessionId: string;
    path: string;
    root: string;
    onClose: () => void;
    onSaved?: () => void;
  }> | null>(null);

  interface Props {
    sessionId: string;
    onNewSession?: (absDir: string) => void;
  }
  const { sessionId, onNewSession }: Props = $props();

  /** Absolute path for a cwd-relative tree entry (root is the live cwd). */
  function absOf(rel: string): string {
    if (!root) return rel;
    if (!rel) return root;
    return root.replace(/\/+$/, '') + '/' + rel;
  }
  function downloadUrl(rel: string): string {
    return api.fsDownloadUrl(sessionId, rel);
  }

  let root = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loadingRoot = $state(true);
  let expanded = $state<Set<string>>(new Set());
  let children = $state<Map<string, FsEntry[]>>(new Map());
  let loadingDirs = $state<Set<string>>(new Set());
  let truncatedDirs = $state<Set<string>>(new Set());
  let editing = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval>;
  let inFlight = false;

  const ROOT_KEY = '';

  onMount(() => {
    void refreshAll(true);
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAll(false);
    }, 3000);
  });
  onDestroy(() => clearInterval(timer));

  async function refreshAll(resetExpanded: boolean) {
    if (inFlight) return;
    inFlight = true;
    try {
      const { cwd } = await api.fsCwd(sessionId);
      const cwdChanged = root !== null && root !== cwd;
      root = cwd;
      error = null;
      if (resetExpanded || cwdChanged) {
        expanded = new Set([ROOT_KEY]);
        children = new Map();
        truncatedDirs = new Set();
      }
      await loadDir(ROOT_KEY, { force: true, silent: !resetExpanded && !cwdChanged });
      if (resetExpanded || cwdChanged) {
        for (const dir of expanded) {
          if (dir !== ROOT_KEY) await loadDir(dir, { force: true, silent: true });
        }
      }
    } catch (e) {
      error = String(e);
    } finally {
      loadingRoot = false;
      inFlight = false;
    }
  }

  async function loadDir(
    dirPath: string,
    opts: { force?: boolean; silent?: boolean } = {},
  ) {
    const force = opts.force ?? false;
    const silent = opts.silent ?? false;
    if (!force && children.has(dirPath)) return;
    if (!silent) loadingDirs = new Set(loadingDirs).add(dirPath);
    try {
      const resp = await api.fsList(sessionId, dirPath);
      const prev = children.get(dirPath);
      const entriesChanged = !prev || !fsEntriesEqual(prev, resp.entries);
      if (entriesChanged) {
        children = new Map(children).set(dirPath, resp.entries);
      }
      const wasTrunc = truncatedDirs.has(dirPath);
      if (resp.truncated !== wasTrunc) {
        truncatedDirs = new Set(truncatedDirs);
        if (resp.truncated) truncatedDirs.add(dirPath);
        else truncatedDirs.delete(dirPath);
      }
    } catch (e) {
      error = String(e);
    } finally {
      if (!silent) {
        const next = new Set(loadingDirs);
        next.delete(dirPath);
        loadingDirs = next;
      }
    }
  }

  async function toggleDir(dirPath: string) {
    const next = new Set(expanded);
    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      next.add(dirPath);
      await loadDir(dirPath, { silent: false });
    }
    expanded = next;
  }

  export function refresh(): void {
    void refreshAll(false);
  }

  async function openFile(filePath: string) {
    if (!EditorModal) {
      EditorModal = (await import('./FileEditorModal.svelte')).default;
    }
    editing = filePath;
  }
</script>

<aside class="panel">
  <header>
    <span class="logo"><Icon name="folder" size={14} /></span>
    <span class="heading">文件</span>
    {#if onNewSession && root}
      <button
        class="ghost icon-only refresh"
        onclick={() => onNewSession?.(root!)}
        title="在当前目录新建会话"
        aria-label="在当前目录新建会话"
      >
        <Icon name="folder-plus" size={14} />
      </button>
    {/if}
    <button class="ghost icon-only refresh" onclick={() => refreshAll(false)} title="刷新" aria-label="刷新">
      <Icon name="refresh" size={14} />
    </button>
  </header>

  {#if loadingRoot && !root}
    <p class="loading">加载中…</p>
  {:else if error && !root}
    <div class="empty">
      <Icon name="alert" size={20} />
      <p>无法读取目录</p>
      <p class="hint">{error}</p>
    </div>
  {:else if root}
    <div class="cwd" title={root}>
      <Icon name="folder" size={11} />
      <span class="cwd-name">{root.split('/').filter(Boolean).pop() ?? root}</span>
    </div>
    <p class="cwd-path" title={root}>{root}</p>

    {#if error}
      <p class="hint error">{error}</p>
    {/if}

    <div class="tree">
      {#each children.get(ROOT_KEY) ?? [] as entry (entry.path)}
        {@render treeNode(entry, 0)}
      {/each}
      {#if loadingDirs.has(ROOT_KEY)}
        <p class="meta-row">加载中…</p>
      {/if}
      {#if truncatedDirs.has(ROOT_KEY)}
        <p class="meta-row">条目过多，仅展示前 500 项</p>
      {/if}
    </div>
  {/if}
</aside>

{#snippet treeNode(entry: FsEntry, depth: number)}
  {#if entry.kind === 'dir'}
    <div class="row-wrap">
      <button
        class="row dir"
        style={`--depth: ${depth}`}
        onclick={() => toggleDir(entry.path)}
        title={entry.path}
      >
        <span class="chev">
          {#if loadingDirs.has(entry.path)}
            <Icon name="refresh" size={12} />
          {:else if expanded.has(entry.path)}
            <Icon name="chevron-down" size={12} />
          {:else}
            <Icon name="chevron-right" size={12} />
          {/if}
        </span>
        <span class="icon folder"><Icon name="folder" size={13} /></span>
        <span class="name">{entry.name}</span>
      </button>
      <span class="row-actions">
        {#if onNewSession}
          <button
            class="row-act"
            onclick={() => onNewSession?.(absOf(entry.path))}
            title="在此目录新建会话"
            aria-label="在此目录新建会话"
          >
            <Icon name="folder-plus" size={13} />
          </button>
        {/if}
        <a
          class="row-act"
          href={downloadUrl(entry.path)}
          title="下载该目录（.tar.gz）"
          aria-label="下载该目录"
        >
          <Icon name="download" size={13} />
        </a>
      </span>
    </div>
    {#if expanded.has(entry.path)}
      {#each children.get(entry.path) ?? [] as child (child.path)}
        {@render treeNode(child, depth + 1)}
      {/each}
      {#if truncatedDirs.has(entry.path)}
        <p class="meta-row" style={`--depth: ${depth + 1}`}>…</p>
      {/if}
    {/if}
  {:else}
    <div class="row-wrap">
      <button
        class="row file"
        style={`--depth: ${depth}`}
        onclick={() => openFile(entry.path)}
        title="{entry.path} — 点击网页编辑"
      >
        <span class="chev" aria-hidden="true"></span>
        <span class="icon file"><Icon name="file" size={13} /></span>
        <span class="name">{entry.name}</span>
      </button>
      <span class="row-actions">
        <a
          class="row-act"
          href={downloadUrl(entry.path)}
          download={entry.name}
          title="下载文件"
          aria-label="下载文件"
        >
          <Icon name="download" size={13} />
        </a>
      </span>
    </div>
  {/if}
{/snippet}

{#if editing && root && EditorModal}
  <EditorModal
    {sessionId}
    path={editing}
    {root}
    onClose={() => (editing = null)}
    onSaved={() => refreshAll(false)}
  />
{/if}

<style>
  .panel {
    width: 260px;
    min-width: 260px;
    max-width: 260px;
    flex: 0 0 260px;
    align-self: stretch;
    box-sizing: border-box;
    background: var(--bg-elev);
    border-right: 1px solid var(--border);
    padding: 16px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    overflow-x: hidden;
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 4px;
    min-width: 0;
    flex-shrink: 0;
  }
  .logo {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    background: var(--accent-soft);
    color: var(--accent);
    border-radius: var(--radius-sm);
    flex-shrink: 0;
  }
  .heading {
    font-weight: 600;
    font-size: 14px;
    flex: 1;
    min-width: 0;
    text-align: left;
  }
  .refresh {
    width: 28px;
    height: 28px;
    padding: 0;
    flex-shrink: 0;
  }

  .loading { color: var(--fg-muted); font-size: 12px; margin: 0; padding: 0 4px; text-align: left; }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    text-align: left;
    color: var(--fg-muted);
    padding: 20px 4px;
    gap: 6px;
  }
  .empty p { margin: 0; font-size: 12.5px; }

  .cwd {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    font-size: 12.5px;
    padding: 0 4px;
    min-width: 0;
    width: 100%;
    text-align: left;
    flex-shrink: 0;
  }
  .cwd-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    text-align: left;
  }
  .cwd-path {
    margin: 0;
    padding: 0 4px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 10.5px;
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    width: 100%;
    text-align: left;
    direction: ltr;
    flex-shrink: 0;
  }

  .hint {
    margin: 0;
    padding: 0 4px;
    font-size: 11px;
    color: var(--fg-muted);
    word-break: break-word;
    text-align: left;
    flex-shrink: 0;
  }
  .hint.error { color: var(--danger); }

  .tree {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    min-width: 0;
    flex: 1;
    min-height: 0;
  }

  .row-wrap {
    display: flex;
    align-items: center;
    width: 100%;
    min-width: 0;
    border-radius: 4px;
  }
  .row-wrap:hover { background: var(--bg-hover); }
  .row-wrap:hover .row { background: transparent; }

  .row {
    --depth: 0;
    display: grid;
    grid-template-columns: 14px 16px minmax(0, 1fr);
    align-items: center;
    gap: 4px;
    flex: 1;
    min-width: 0;
    box-sizing: border-box;
    margin: 0;
    padding: 4px 4px 4px calc(4px + var(--depth) * 14px);
    border-radius: 4px;
    border: 1px solid transparent;
    background: transparent;
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 12px;
    height: auto;
    color: inherit;
  }
  .row:hover { background: var(--bg-hover); }
  .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .row-actions {
    display: flex;
    align-items: center;
    gap: 1px;
    flex-shrink: 0;
    padding-right: 2px;
    /* Kept dimly visible (not hover-only) so the actions are discoverable at a
       glance and usable on touch devices; they brighten on hover/focus. */
    opacity: 0.4;
    transition: opacity 0.1s ease;
  }
  .row-wrap:hover .row-actions,
  .row-actions:focus-within { opacity: 1; }
  .row-act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    background: transparent;
    color: var(--fg-muted);
    border-radius: 4px;
    cursor: pointer;
    text-decoration: none;
  }
  .row-act:hover { background: var(--accent-soft); color: var(--accent); }
  .row-act:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; opacity: 1; }

  .chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--fg-muted);
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    flex-shrink: 0;
  }
  .icon.folder { color: var(--accent); }
  .icon.file { color: var(--fg-muted); }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    text-align: left;
    direction: ltr;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 11.5px;
  }

  .meta-row {
    margin: 0;
    padding: 4px 4px 4px calc(4px + var(--depth, 0) * 14px + 34px);
    font-size: 11px;
    color: var(--fg-muted);
    text-align: left;
  }
</style>

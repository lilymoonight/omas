<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { api, type GitStatus, type GitFile } from '../lib/api.js';
  import { gitStatusEqual } from '../lib/stable-update.js';
  import Icon from './Icon.svelte';
  import type { Component } from 'svelte';

  let DiffModal = $state<Component<{
    sessionId: string;
    path: string;
    staged: boolean;
    root: string;
    onClose: () => void;
    onSaved?: () => void;
  }> | null>(null);

  interface Props { sessionId: string; }
  const { sessionId }: Props = $props();

  let status = $state<GitStatus | null>(null);
  let timer: ReturnType<typeof setInterval>;
  let inFlight = false;
  let viewing = $state<{ path: string; staged: boolean } | null>(null);

  async function open(path: string, staged: boolean): Promise<void> {
    if (!DiffModal) {
      DiffModal = (await import('./FileDiffModal.svelte')).default;
    }
    viewing = { path, staged };
  }

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    try {
      const next = await api.gitStatus(sessionId);
      if (!gitStatusEqual(status, next)) status = next;
    } catch {
      // keep last status on error
    } finally {
      inFlight = false;
    }
  }

  onMount(() => {
    void refresh();
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 3000);
  });
  onDestroy(() => clearInterval(timer));

  // Group files into staged (index char != ' ' && != '?')
  // and unstaged/untracked sections.
  type Grouped = { staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[] };
  function group(files: GitFile[]): Grouped {
    const out: Grouped = { staged: [], unstaged: [], untracked: [] };
    for (const f of files) {
      if (f.index === '?' && f.worktree === '?') out.untracked.push(f);
      else {
        if (f.index !== ' ' && f.index !== '?') out.staged.push(f);
        if (f.worktree !== ' ' && f.worktree !== '?') out.unstaged.push(f);
      }
    }
    return out;
  }

  // Split a repo-relative path into a directory prefix (trailing slash) and
  // the basename. Used for two-tone rendering so the filename stays fully
  // visible even when the parent dir gets ellipsized.
  function splitPath(p: string): { dir: string; base: string } {
    const i = p.lastIndexOf('/');
    if (i < 0) return { dir: '', base: p };
    return { dir: p.slice(0, i + 1), base: p.slice(i + 1) };
  }

  // Map a status char to a short Chinese label and color class.
  function labelOf(ch: string): { text: string; tone: string } | null {
    switch (ch) {
      case 'M': return { text: '改', tone: 'mod' };
      case 'A': return { text: '增', tone: 'add' };
      case 'D': return { text: '删', tone: 'del' };
      case 'R': return { text: '更名', tone: 'mod' };
      case 'C': return { text: '复制', tone: 'add' };
      case 'U': return { text: '冲突', tone: 'del' };
      case '?': return { text: '未跟踪', tone: 'untracked' };
      case '!': return { text: '已忽略', tone: 'dim' };
      default: return null;
    }
  }
</script>

<aside class="panel">
  <header>
    <span class="logo"><Icon name="git-branch" size={14} /></span>
    <span class="heading">Git 变更</span>
  </header>

  {#if !status}
    <p class="loading">加载中…</p>
  {:else if !status.available}
    <div class="empty">
      {#if status.reason === 'not_a_repo'}
        <Icon name="folder" size={22} />
        <p>当前目录不是 Git 仓库</p>
        {#if status.cwd}<p class="cwd" title={status.cwd}>{status.cwd}</p>{/if}
      {:else if status.reason === 'git_not_installed'}
        <Icon name="alert" size={22} />
        <p>系统未安装 git</p>
      {:else if status.reason === 'no_cwd'}
        <Icon name="eye-off" size={22} />
        <p>无法读取 shell 当前目录</p>
      {:else}
        <Icon name="alert" size={22} />
        <p>读取失败</p>
        {#if status.message}<p class="cwd">{status.message}</p>{/if}
      {/if}
    </div>
  {:else}
    {@const g = group(status.files)}
    <div class="branch">
      <span class="branch-name" title={status.branch.upstream ?? ''}>
        {status.branch.name ?? '(detached)'}
      </span>
      {#if status.branch.upstream}
        <div class="ab">
          {#if status.branch.ahead > 0}<span class="ahead"><Icon name="arrow-up" size={11} />{status.branch.ahead}</span>{/if}
          {#if status.branch.behind > 0}<span class="behind"><Icon name="arrow-down" size={11} />{status.branch.behind}</span>{/if}
        </div>
      {/if}
    </div>
    <div class="cwd" title={status.cwd}>
      <Icon name="folder" size={11} /> {status.cwd}
    </div>

    {#if status.files.length === 0}
      <div class="clean">
        <Icon name="check" size={18} />
        <span>工作区干净</span>
      </div>
    {:else}
      {#if g.staged.length > 0}
        <h4>已暂存 <span class="count">{g.staged.length}</span></h4>
        <ul>
          {#each g.staged as f (f.path + ':s')}
            {@const lbl = labelOf(f.index)}
            {@const p = splitPath(f.path)}
            <li>
              <button class="row" onclick={() => open(f.path, true)} title="点击查看 diff">
                {#if lbl}<span class="badge tone-{lbl.tone}">{lbl.text}</span>{/if}
                <span class="path" title={f.path}>
                  {#if p.dir}<span class="path-dir">{p.dir}</span>{/if}
                  <span class="path-base">{p.base}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if g.unstaged.length > 0}
        <h4>未暂存 <span class="count">{g.unstaged.length}</span></h4>
        <ul>
          {#each g.unstaged as f (f.path + ':w')}
            {@const lbl = labelOf(f.worktree)}
            {@const p = splitPath(f.path)}
            <li>
              <button class="row" onclick={() => open(f.path, false)} title="点击查看 diff">
                {#if lbl}<span class="badge tone-{lbl.tone}">{lbl.text}</span>{/if}
                <span class="path" title={f.path}>
                  {#if p.dir}<span class="path-dir">{p.dir}</span>{/if}
                  <span class="path-base">{p.base}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if g.untracked.length > 0}
        <h4>未跟踪 <span class="count">{g.untracked.length}</span></h4>
        <ul>
          {#each g.untracked as f (f.path + ':u')}
            {@const p = splitPath(f.path)}
            <li>
              <button class="row" onclick={() => open(f.path, false)} title="点击查看文件内容">
                <span class="badge tone-untracked">新</span>
                <span class="path" title={f.path}>
                  {#if p.dir}<span class="path-dir">{p.dir}</span>{/if}
                  <span class="path-base">{p.base}</span>
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if status.truncated}
        <p class="truncated">变更过多，仅展示前 500 项</p>
      {/if}
    {/if}
  {/if}
</aside>

{#if viewing && status?.available && DiffModal}
  <DiffModal
    {sessionId}
    path={viewing.path}
    staged={viewing.staged}
    root={status.root}
    onClose={() => (viewing = null)}
    onSaved={refresh}
  />
{/if}

<style>
  .panel {
    width: 300px;
    min-width: 300px;
    max-width: 300px;
    flex: 0 0 300px;
    align-self: stretch;
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    padding: 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
  }
  header { display: flex; align-items: center; gap: 8px; }
  .logo {
    display: inline-flex; align-items: center; justify-content: center;
    width: 24px; height: 24px;
    background: var(--accent-soft); color: var(--accent);
    border-radius: var(--radius-sm);
  }
  .heading { font-weight: 600; font-size: 14px; }

  .loading { color: var(--fg-muted); font-size: 12px; margin: 0; }

  .branch {
    display: flex; align-items: center; gap: 8px;
    margin-top: 4px;
  }
  .branch-name {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 12.5px; font-weight: 600;
    background: var(--bg-hover);
    padding: 3px 8px; border-radius: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
  }
  .ab { display: flex; gap: 4px; }
  .ab span {
    display: inline-flex; align-items: center; gap: 2px;
    font-size: 11px; font-weight: 600;
    padding: 2px 6px; border-radius: 4px;
    font-variant-numeric: tabular-nums;
  }
  .ab .ahead  { background: var(--success-soft); color: var(--success); }
  .ab .behind { background: var(--accent-soft); color: var(--accent); }

  .cwd {
    display: inline-flex; align-items: center; gap: 4px;
    color: var(--fg-muted); font-size: 11px;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }

  .empty {
    display: flex; flex-direction: column; align-items: center;
    text-align: center; color: var(--fg-muted);
    padding: 24px 8px; gap: 6px;
  }
  .empty p { margin: 0; font-size: 12.5px; }

  .clean {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--success-soft); color: var(--success);
    padding: 8px 12px; border-radius: var(--radius-sm);
    font-size: 13px; font-weight: 500;
  }

  h4 {
    margin: 8px 0 4px;
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--fg-muted); font-weight: 600;
    display: flex; align-items: center; gap: 6px;
  }
  .count {
    background: var(--bg-hover); color: var(--fg-muted);
    border-radius: 999px; padding: 0 6px;
    font-size: 10px; font-weight: 600;
    text-transform: none;
  }

  ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
  li { display: flex; }
  /* Row is a button so click + keyboard activation both work. Reset all
     default button chrome so it looks like a plain list row. */
  .row {
    display: flex; align-items: center; gap: 8px;
    width: 100%; min-width: 0;
    padding: 4px 6px;
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
  .row:hover { background: var(--bg-hover); border-color: transparent; }
  .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  .badge {
    display: inline-flex; align-items: center;
    flex-shrink: 0;
    font-size: 10.5px; font-weight: 600;
    padding: 1px 6px; border-radius: 4px;
    min-width: 36px;
    justify-content: center;
  }
  .tone-mod       { background: var(--warning-soft); color: var(--warning); }
  .tone-add       { background: var(--success-soft); color: var(--success); }
  .tone-del       { background: var(--danger-soft); color: var(--danger); }
  .tone-untracked { background: var(--accent-soft); color: var(--accent); }
  .tone-dim       { background: var(--bg-hover); color: var(--fg-muted); }

  .path {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 12px;
    display: flex;
    align-items: baseline;
    flex: 1; min-width: 0;
    white-space: nowrap;
    overflow: hidden;
  }
  /* Directory part shrinks first and clips with ellipsis on the LEFT, so the
     filename remains fully visible no matter how deep the path. */
  .path-dir {
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
    min-width: 0;
    flex: 1 1 auto;
  }
  .path-base {
    color: var(--fg);
    flex: 0 0 auto;
  }

  .truncated {
    margin: 8px 0 0;
    font-size: 11px; color: var(--fg-muted);
    text-align: center;
  }
</style>

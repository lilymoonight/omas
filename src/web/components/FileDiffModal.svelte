<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type GitFileResp } from '../lib/api.js';
  import Icon from './Icon.svelte';
  import CodeEditor from './CodeEditor.svelte';

  interface Props {
    sessionId: string;
    path: string;
    staged: boolean;
    /** Git repo root — used to build an absolute path for the editor. */
    root: string;
    onClose: () => void;
    onSaved?: () => void;
  }
  const { sessionId, path, staged, root, onClose, onSaved }: Props = $props();

  type ViewMode = 'diff' | 'edit';

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<GitFileResp | null>(null);
  let mode = $state<ViewMode>('diff');
  let editContent = $state('');
  let savedContent = $state('');
  let editLoading = $state(false);
  let editClipped = $state(false);
  let saving = $state(false);
  let saveOk = $state<string | null>(null);
  let openingEditor = $state(false);

  let dirty = $derived(mode === 'edit' && editContent !== savedContent);

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    saveOk = null;
    try {
      data = await api.gitFile(sessionId, path, staged, 'diff');
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function ensureEditContent() {
    if (editLoading) return;
    editLoading = true;
    error = null;
    try {
      const resp = await api.gitFile(sessionId, path, staged, 'content');
      if (resp.kind === 'binary') {
        error = '二进制文件无法在网页中编辑';
        mode = 'diff';
        return;
      }
      if (resp.kind === 'diff') {
        error = '差异视图无法直接编辑，请切换到终端';
        mode = 'diff';
        return;
      }
      editContent = resp.content;
      savedContent = resp.content;
      editClipped = resp.clipped;
    } catch (e) {
      error = String(e);
      mode = 'diff';
    } finally {
      editLoading = false;
    }
  }

  async function switchMode(next: ViewMode) {
    if (next === mode) return;
    if (next === 'edit') {
      mode = 'edit';
      if (!editContent && !editLoading) await ensureEditContent();
      return;
    }
    mode = 'diff';
  }

  async function saveEdit() {
    if (saving || !dirty || editClipped) return;
    saving = true;
    error = null;
    saveOk = null;
    try {
      const result = await api.saveGitFile(sessionId, path, editContent);
      savedContent = editContent;
      saveOk = `已保存（${(result.size / 1024).toFixed(1)} KiB）`;
      onSaved?.();
      data = await api.gitFile(sessionId, path, staged, 'diff');
    } catch (e) {
      error = `保存失败：${e}`;
    } finally {
      saving = false;
    }
  }

  function classOfLine(l: string): string {
    if (l.startsWith('+++') || l.startsWith('---')) return 'meta';
    if (l.startsWith('@@')) return 'hunk';
    if (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('similarity ') ||
        l.startsWith('rename ') || l.startsWith('new file') || l.startsWith('deleted file')) return 'meta';
    if (l.startsWith('+')) return 'add';
    if (l.startsWith('-')) return 'del';
    return 'ctx';
  }

  let lines = $derived.by(() => {
    if (!data) return [];
    const text = data.kind === 'diff' ? data.diff
               : data.kind === 'untracked' ? data.content.split('\n').map((l) => '+' + l).join('\n')
               : data.kind === 'deleted'   ? data.content.split('\n').map((l) => '-' + l).join('\n')
               : '';
    const raw = text.split('\n');
    if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
    return raw.map((text) => ({ text, cls: classOfLine(text) }));
  });

  let stats = $derived.by(() => {
    let add = 0, del = 0;
    for (const { cls } of lines) {
      if (cls === 'add') add++;
      else if (cls === 'del') del++;
    }
    return { add, del };
  });

  let canWebEdit = $derived(data?.kind !== 'binary');

  async function openInEditor() {
    if (openingEditor) return;
    openingEditor = true;
    try {
      const abs = `${root.replace(/\/$/, '')}/${path}`;
      await api.writeSession(sessionId, `\${EDITOR:-vi} ${JSON.stringify(abs)}\n`);
      onClose();
    } catch (e) {
      error = `打开编辑器失败：${e}`;
    } finally {
      openingEditor = false;
    }
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && mode === 'edit') {
      e.preventDefault();
      void saveEdit();
    }
  }
</script>

<svelte:window onkeydown={keydown} />

<div class="backdrop" onclick={onClose} role="presentation">
  <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="dlg-title">
    <header>
      <div class="title-row">
        <span class="file-icon"><Icon name="file" size={14} /></span>
        <span class="path" id="dlg-title" title={path}>{path}</span>
        <span class="badge-staged">{staged ? '已暂存' : '未暂存'}</span>
        {#if dirty}<span class="badge-dirty">未保存</span>{/if}
      </div>
      <div class="actions">
        {#if data && data.kind === 'diff' && mode === 'diff'}
          <span class="stats">
            <span class="stat-add">+{stats.add}</span>
            <span class="stat-del">−{stats.del}</span>
          </span>
        {/if}
        {#if canWebEdit}
          <div class="tabs">
            <button class="tab" class:active={mode === 'diff'} onclick={() => switchMode('diff')}>差异</button>
            <button class="tab" class:active={mode === 'edit'} onclick={() => switchMode('edit')}>编辑</button>
          </div>
        {/if}
        {#if mode === 'edit'}
          <button class="primary" onclick={saveEdit} disabled={saving || !dirty || editClipped || editLoading}>
            {#if saving}<Icon name="refresh" size={14} />保存中…
            {:else}<Icon name="check" size={14} />保存{/if}
          </button>
        {/if}
        <button class="ghost" onclick={openInEditor} disabled={openingEditor} title="在当前终端用 $EDITOR 打开">
          {#if openingEditor}<Icon name="refresh" size={14} />编辑中…
          {:else}<Icon name="terminal" size={14} />终端{/if}
        </button>
        <button class="ghost icon-only" onclick={onClose} title="关闭 (Esc)" aria-label="关闭">
          <Icon name="x" size={16} />
        </button>
      </div>
    </header>

    <div class="body">
      {#if loading}
        <p class="state">加载中…</p>
      {:else if error}
        <p class="state error"><Icon name="alert" size={14} /> {error}</p>
      {:else if data?.kind === 'binary'}
        <p class="state"><Icon name="alert" size={14} /> 二进制文件，不展示内容（{(data.size / 1024).toFixed(1)} KiB）</p>
      {:else if mode === 'edit'}
        {#if editLoading}
          <p class="state">加载文件内容…</p>
        {:else}
          {#if editClipped}
            <p class="state warn"><Icon name="alert" size={14} /> 文件过大（超过 2 MiB），仅展示部分内容，无法安全保存。请用终端编辑。</p>
          {/if}
          {#if saveOk}
            <p class="state ok"><Icon name="check" size={14} /> {saveOk}</p>
          {/if}
          {#key path}
            <CodeEditor
              {path}
              value={editContent}
              readonly={editClipped}
              onChange={(v) => { editContent = v; }}
            />
          {/key}
        {/if}
      {:else if lines.length === 0}
        <p class="state">空（无差异）</p>
      {:else}
        <table>
          <tbody>
            {#each lines as l, i (i)}
              <tr class={'l-' + l.cls}>
                <td class="ln">{i + 1}</td>
                <td class="content">{l.text || ' '}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if data && 'clipped' in data && data.clipped}
          <p class="state">文件过大，仅展示前 512 KiB。切换到「编辑」或「终端」打开全文。</p>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .backdrop {
    position: fixed; inset: 0;
    background: rgba(20, 24, 30, 0.55);
    backdrop-filter: blur(2px);
    display: flex; align-items: center; justify-content: center;
    z-index: 1000;
    padding: 4vh 4vw;
  }
  .modal {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    width: min(1100px, 100%);
    height: min(85vh, 900px);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-soft);
    flex-shrink: 0;
  }
  .title-row { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; }
  .file-icon { color: var(--accent); display: inline-flex; }
  .path {
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 13px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    direction: rtl; text-align: left;
  }
  .badge-staged, .badge-dirty {
    background: var(--bg-hover); color: var(--fg-muted);
    border-radius: 999px; padding: 1px 8px;
    font-size: 11px; font-weight: 500;
    flex-shrink: 0;
  }
  .badge-dirty { background: var(--warning-soft); color: var(--warning); }
  .actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .tabs {
    display: inline-flex;
    background: var(--bg-hover);
    border-radius: var(--radius-sm);
    padding: 2px;
    gap: 2px;
  }
  .tab {
    border: none;
    background: transparent;
    color: var(--fg-muted);
    font-size: 12px;
    font-weight: 500;
    padding: 4px 10px;
    border-radius: calc(var(--radius-sm) - 2px);
    height: auto;
  }
  .tab.active {
    background: var(--bg-elev);
    color: var(--fg);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
  }
  .stats {
    display: inline-flex; gap: 6px; align-items: center;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 12px; font-variant-numeric: tabular-nums;
    padding: 0 4px;
  }
  .stat-add { color: var(--success); font-weight: 600; }
  .stat-del { color: var(--danger);  font-weight: 600; }

  .body {
    flex: 1; min-height: 0;
    overflow: auto;
    background: var(--bg-elev);
    display: flex;
    flex-direction: column;
  }
  .state {
    color: var(--fg-muted); font-size: 13px; padding: 16px;
    display: inline-flex; align-items: center; gap: 6px;
    flex-shrink: 0;
  }
  .state.error { color: var(--danger); }
  .state.warn { color: var(--warning); }
  .state.ok { color: var(--success); }

  table {
    border-collapse: collapse;
    width: 100%;
    font-family: ui-monospace, "JetBrains Mono", Menlo, monospace;
    font-size: 12.5px;
    line-height: 1.45;
    table-layout: fixed;
  }
  td { padding: 0 6px; vertical-align: top; }
  td.ln {
    width: 52px;
    color: var(--fg-dim);
    text-align: right;
    user-select: none;
    border-right: 1px solid var(--border);
    background: var(--bg-soft);
    font-variant-numeric: tabular-nums;
  }
  td.content {
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg);
  }
  tr.l-add td.content { background: var(--success-soft); color: var(--success); }
  tr.l-add td.ln { background: color-mix(in srgb, var(--success) 22%, var(--bg-elev)); }
  tr.l-del td.content { background: var(--danger-soft); color: var(--danger); }
  tr.l-del td.ln { background: color-mix(in srgb, var(--danger) 22%, var(--bg-elev)); }
  tr.l-hunk td { background: var(--bg-hover); color: var(--accent); }
  tr.l-meta td { background: var(--bg-soft); color: var(--fg-muted); font-weight: 500; }
</style>

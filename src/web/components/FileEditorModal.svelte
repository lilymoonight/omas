<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import Icon from './Icon.svelte';
  import CodeEditor from './CodeEditor.svelte';

  interface Props {
    sessionId: string;
    path: string;
    root: string;
    onClose: () => void;
    onSaved?: () => void;
  }
  const { sessionId, path, root, onClose, onSaved }: Props = $props();

  let loading = $state(true);
  let error = $state<string | null>(null);
  let editContent = $state('');
  let savedContent = $state('');
  let clipped = $state(false);
  let binary = $state(false);
  let saving = $state(false);
  let saveOk = $state<string | null>(null);

  let dirty = $derived(editContent !== savedContent);
  let fileName = $derived(path.split('/').pop() ?? path);

  onMount(load);

  async function load() {
    loading = true;
    error = null;
    saveOk = null;
    try {
      const resp = await api.fsRead(sessionId, path);
      if (resp.binary) {
        binary = true;
        return;
      }
      editContent = resp.content;
      savedContent = resp.content;
      clipped = resp.clipped;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (saving || !dirty || clipped || binary) return;
    saving = true;
    error = null;
    saveOk = null;
    try {
      const result = await api.fsWrite(sessionId, path, editContent);
      savedContent = editContent;
      saveOk = `已保存（${(result.size / 1024).toFixed(1)} KiB）`;
      onSaved?.();
    } catch (e) {
      error = `保存失败：${e}`;
    } finally {
      saving = false;
    }
  }

  function keydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      onClose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void save();
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
        {#if dirty}<span class="badge-dirty">未保存</span>{/if}
      </div>
      <div class="actions">
        <button class="primary" onclick={save} disabled={saving || !dirty || clipped || binary || loading}>
          {#if saving}<Icon name="refresh" size={14} />保存中…
          {:else}<Icon name="check" size={14} />保存{/if}
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
      {:else if binary}
        <p class="state"><Icon name="alert" size={14} /> {fileName} 是二进制文件，无法在网页中编辑</p>
      {:else}
        {#if clipped}
          <p class="state warn"><Icon name="alert" size={14} /> 文件过大（超过 2 MiB），仅展示部分内容，无法安全保存</p>
        {/if}
        {#if saveOk}
          <p class="state ok"><Icon name="check" size={14} /> {saveOk}</p>
        {/if}
        {#key path}
          <CodeEditor
            {path}
            value={editContent}
            readonly={clipped}
            onChange={(v) => { editContent = v; }}
          />
        {/key}
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
    text-align: left;
    direction: ltr;
  }
  .badge-dirty {
    background: #fff8e1; color: #946800;
    border-radius: 999px; padding: 1px 8px;
    font-size: 11px; font-weight: 500;
    flex-shrink: 0;
  }
  .actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .body {
    flex: 1; min-height: 0;
    overflow: auto;
    background: #ffffff;
    display: flex;
    flex-direction: column;
  }
  .state {
    color: var(--fg-muted); font-size: 13px; padding: 16px;
    display: inline-flex; align-items: center; gap: 6px;
    flex-shrink: 0;
  }
  .state.error { color: var(--danger); }
  .state.warn { color: #946800; }
  .state.ok { color: var(--success); }
</style>

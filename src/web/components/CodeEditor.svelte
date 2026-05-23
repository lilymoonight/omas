<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { EditorState, Compartment, type Extension } from '@codemirror/state';
  import { EditorView, keymap } from '@codemirror/view';
  import { basicSetup } from 'codemirror';
  import { indentWithTab } from '@codemirror/commands';
  import { loadLanguageForPath } from '../lib/codemirror-lang.js';

  interface Props {
    path: string;
    value?: string;
    readonly?: boolean;
    onChange?: (value: string) => void;
  }

  let {
    path,
    value = '',
    readonly = false,
    onChange,
  }: Props = $props();

  let host = $state<HTMLDivElement | undefined>(undefined);
  let view: EditorView | null = null;
  let syncing = false;
  let langLoadId = 0;

  const editableComp = new Compartment();
  const languageComp = new Compartment();

  const editorTheme = EditorView.theme({
    '&': { height: '100%' },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
      fontSize: '12.5px',
      lineHeight: '1.45',
    },
    '.cm-content': { padding: '8px 0' },
    '.cm-gutters': {
      backgroundColor: '#f6f8fa',
      borderRight: '1px solid #e8e8e8',
      color: '#8b949e',
    },
    '.cm-activeLineGutter': { backgroundColor: '#eef1f4' },
    '.cm-activeLine': { backgroundColor: '#f6f8fa' },
  });

  function buildExtensions(lang: Extension[]): Extension[] {
    return [
      basicSetup,
      editorTheme,
      EditorView.lineWrapping,
      languageComp.of(lang),
      editableComp.of(EditorState.readOnly.of(readonly)),
      keymap.of([indentWithTab]),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || syncing || !onChange) return;
        onChange(u.state.doc.toString());
      }),
    ];
  }

  async function applyLanguage(nextPath: string): Promise<void> {
    const id = ++langLoadId;
    const lang = await loadLanguageForPath(nextPath);
    if (id !== langLoadId || !view) return;
    view.dispatch({ effects: languageComp.reconfigure(lang) });
  }

  onMount(async () => {
    if (!host) return;
    const lang = await loadLanguageForPath(path);
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: value, extensions: buildExtensions(lang) }),
    });
  });

  onDestroy(() => {
    view?.destroy();
    view = null;
  });

  $effect(() => {
    if (!view) return;
    void applyLanguage(path);
  });

  $effect(() => {
    if (!view) return;
    view.dispatch({ effects: editableComp.reconfigure(EditorState.readOnly.of(readonly)) });
  });

  $effect(() => {
    if (!view) return;
    const cur = view.state.doc.toString();
    if (value === cur) return;
    syncing = true;
    view.dispatch({
      changes: { from: 0, to: cur.length, insert: value },
    });
    syncing = false;
  });
</script>

<div class="cm-host" bind:this={host} aria-label="文件内容"></div>

<style>
  .cm-host {
    flex: 1;
    min-height: 0;
    width: 100%;
    overflow: hidden;
    text-align: left;
    direction: ltr;
  }
  .cm-host :global(.cm-editor) {
    height: 100%;
  }
</style>

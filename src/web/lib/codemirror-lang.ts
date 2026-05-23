import { StreamLanguage } from '@codemirror/language';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { css } from '@codemirror/lang-css';
import { go } from '@codemirror/lang-go';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import type { Extension } from '@codemirror/state';

const shellLanguage = StreamLanguage.define(shell);

const SHELL_FILENAMES = new Set([
  'bashrc',
  'bash_profile',
  'zshrc',
  'zprofile',
  'profile',
  'envrc',
]);

/** Pick a syntax-highlighting extension from the file path. */
export function languageForPath(path: string): Extension[] {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : '';

  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return [];

  if (SHELL_FILENAMES.has(ext) || SHELL_FILENAMES.has(base.replace(/^\./, ''))) {
    return [shellLanguage];
  }

  switch (ext) {
    case 'ts':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })];
    case 'js':
    case 'mjs':
    case 'cjs':
      return [javascript()];
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'json':
    case 'jsonc':
      return [json()];
    case 'md':
    case 'markdown':
      return [markdown()];
    case 'py':
      return [python()];
    case 'css':
    case 'scss':
      return [css()];
    case 'html':
    case 'htm':
      return [html()];
    case 'svelte':
    case 'vue':
      return [html()];
    case 'yaml':
    case 'yml':
      return [yaml()];
    case 'rs':
      return [rust()];
    case 'go':
      return [go()];
    case 'sql':
      return [sql()];
    case 'sh':
    case 'bash':
    case 'zsh':
      return [shellLanguage];
    case 'xml':
    case 'svg':
      return [xml()];
    default:
      return [];
  }
}

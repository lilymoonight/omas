import type { Extension } from '@codemirror/state';

const SHELL_FILENAMES = new Set([
  'bashrc',
  'bash_profile',
  'zshrc',
  'zprofile',
  'profile',
  'envrc',
]);

function extOf(path: string): { base: string; ext: string } {
  const base = path.split('/').pop()?.toLowerCase() ?? '';
  const ext = base.includes('.') ? (base.split('.').pop() ?? '') : '';
  return { base, ext };
}

/** Load syntax-highlighting extensions on demand to keep the main bundle smaller. */
export async function loadLanguageForPath(path: string): Promise<Extension[]> {
  const { base, ext } = extOf(path);

  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return [];

  if (SHELL_FILENAMES.has(ext) || SHELL_FILENAMES.has(base.replace(/^\./, ''))) {
    const { StreamLanguage } = await import('@codemirror/language');
    const { shell } = await import('@codemirror/legacy-modes/mode/shell');
    return [StreamLanguage.define(shell)];
  }

  switch (ext) {
    case 'ts': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript({ typescript: true })];
    }
    case 'tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript({ typescript: true, jsx: true })];
    }
    case 'js':
    case 'mjs':
    case 'cjs': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript()];
    }
    case 'jsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript({ jsx: true })];
    }
    case 'json':
    case 'jsonc': {
      const { json } = await import('@codemirror/lang-json');
      return [json()];
    }
    case 'md':
    case 'markdown': {
      const { markdown } = await import('@codemirror/lang-markdown');
      return [markdown()];
    }
    case 'py': {
      const { python } = await import('@codemirror/lang-python');
      return [python()];
    }
    case 'css':
    case 'scss': {
      const { css } = await import('@codemirror/lang-css');
      return [css()];
    }
    case 'html':
    case 'htm':
    case 'svelte':
    case 'vue': {
      const { html } = await import('@codemirror/lang-html');
      return [html()];
    }
    case 'yaml':
    case 'yml': {
      const { yaml } = await import('@codemirror/lang-yaml');
      return [yaml()];
    }
    case 'rs': {
      const { rust } = await import('@codemirror/lang-rust');
      return [rust()];
    }
    case 'go': {
      const { go } = await import('@codemirror/lang-go');
      return [go()];
    }
    case 'sql': {
      const { sql } = await import('@codemirror/lang-sql');
      return [sql()];
    }
    case 'sh':
    case 'bash':
    case 'zsh': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { shell } = await import('@codemirror/legacy-modes/mode/shell');
      return [StreamLanguage.define(shell)];
    }
    case 'xml':
    case 'svg': {
      const { xml } = await import('@codemirror/lang-xml');
      return [xml()];
    }
    default:
      return [];
  }
}

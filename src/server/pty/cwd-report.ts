import fs from 'node:fs';
import path from 'node:path';

/** Emit OSC 7 so the server can track `cd` instantly (no polling). */
export function shellKind(shell: string): 'zsh' | 'bash' | 'fish' | null {
  const base = path.basename(shell).toLowerCase();
  if (base.includes('zsh')) return 'zsh';
  if (base.includes('bash')) return 'bash';
  if (base === 'fish') return 'fish';
  return null;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shell snippet that prints OSC 7 for the current `$PWD`. */
export function cwdReportHook(shell: string): string {
  switch (shellKind(shell)) {
    case 'zsh':
      return [
        '__omas_report_cwd() {',
        '  printf "\\033]7;file://%s%s\\033\\\\" "${HOST-${HOSTNAME-$(hostname)}}" "$PWD"',
        '}',
        'chpwd_functions+=(__omas_report_cwd)',
        '__omas_report_cwd',
      ].join('\n');
    case 'bash':
      return [
        '__omas_report_cwd() {',
        '  printf "\\033]7;file://%s%s\\033\\\\" "${HOSTNAME:-localhost}" "$PWD"',
        '}',
        'if [[ -n "$PROMPT_COMMAND" ]]; then',
        '  PROMPT_COMMAND="__omas_report_cwd; $PROMPT_COMMAND"',
        'else',
        '  PROMPT_COMMAND="__omas_report_cwd"',
        'fi',
        '__omas_report_cwd',
      ].join('\n');
    case 'fish':
      return [
        'function __omas_report_cwd --on-variable PWD',
        '  printf "\\033]7;file://%s%s\\033\\\\" (hostname) "$PWD"',
        'end',
        '__omas_report_cwd',
      ].join('\n');
    default:
      return '';
  }
}

export type SessionRcOpts = {
  home: string;
  shell: string;
  /** Extra lines appended after cwd hook (e.g. sandbox agent aliases). */
  extra?: string;
};

export function buildSessionRcContent(opts: SessionRcOpts): string {
  const hook = cwdReportHook(opts.shell);
  const extra = opts.extra?.trim();
  const h = shellQuote(opts.home);
  switch (shellKind(opts.shell)) {
    case 'zsh':
      return [
        '# omas session rc',
        `[ -f ${h}/.zshrc ] && . ${h}/.zshrc`,
        hook,
        extra,
      ].filter(Boolean).join('\n') + '\n';
    case 'bash':
      return [
        '# omas session rc',
        `[ -f ${h}/.bashrc ] && . ${h}/.bashrc`,
        hook,
        extra,
      ].filter(Boolean).join('\n') + '\n';
    case 'fish':
      return ['# omas session rc', hook, extra].filter(Boolean).join('\n') + '\n';
    default:
      return hook ? `${hook}\n` : '';
  }
}

export function sessionShellArgs(shell: string, rcPath: string): string[] {
  switch (shellKind(shell)) {
    case 'zsh':
      return ['--rcfile', rcPath];
    case 'bash':
      return ['--rcfile', rcPath, '-i'];
    case 'fish':
      return ['--init-command', fs.readFileSync(rcPath, 'utf8').replace(/\n/g, '; ')];
    default:
      return [];
  }
}

export function writeSessionRc(tmpDir: string, opts: SessionRcOpts): string | null {
  if (!shellKind(opts.shell)) return null;
  fs.mkdirSync(tmpDir, { recursive: true });
  const rcPath = path.join(tmpDir, '.omas-session-rc');
  fs.writeFileSync(rcPath, buildSessionRcContent(opts), { mode: 0o600 });
  return rcPath;
}

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

function quotedHomeRc(home: string, name: string): string {
  return shellQuote(path.join(home, name));
}

function sessionRcBasename(shell: string): string | null {
  switch (shellKind(shell)) {
    case 'zsh':
      return '.zshrc';
    case 'bash':
    case 'fish':
      return '.omas-session-rc';
    default:
      return null;
  }
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
      ].join('\n');
    case 'fish':
      return [
        'function __omas_report_cwd --on-variable PWD',
        '  printf "\\033]7;file://%s%s\\033\\\\" (hostname) "$PWD"',
        'end',
      ].join('\n');
    default:
      return '';
  }
}

/** Return to the session workspace after user rc (which may cd elsewhere). */
export function sessionDirHook(shell: string): string {
  switch (shellKind(shell)) {
    case 'zsh':
      return [
        '__omas_cd_session() {',
        '  [[ -z "$OMAS_SESSION_CWD" || ! -d "$OMAS_SESSION_CWD" ]] && return',
        '  builtin cd -- "$OMAS_SESSION_CWD" 2>/dev/null || return',
        '  __omas_report_cwd',
        '}',
        '__omas_cd_session',
      ].join('\n');
    case 'bash':
      return [
        '__omas_cd_session() {',
        '  [[ -z "$OMAS_SESSION_CWD" || ! -d "$OMAS_SESSION_CWD" ]] && return',
        '  cd "$OMAS_SESSION_CWD" 2>/dev/null || return',
        '  __omas_report_cwd',
        '}',
        '__omas_cd_session',
      ].join('\n');
    case 'fish':
      return [
        'function __omas_cd_session',
        '  if test -n "$OMAS_SESSION_CWD"; and test -d "$OMAS_SESSION_CWD"',
        '    cd "$OMAS_SESSION_CWD"',
        '    __omas_report_cwd',
        '  end',
        'end',
        '__omas_cd_session',
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
  const tail = sessionDirHook(opts.shell);
  const extra = opts.extra?.trim();
  const zdot = quotedHomeRc(opts.home, '.zshrc');
  const bashrc = quotedHomeRc(opts.home, '.bashrc');
  switch (shellKind(opts.shell)) {
    case 'zsh':
      return [
        '# omas session rc',
        `[ -f ${zdot} ] && . ${zdot}`,
        hook,
        extra,
        tail,
      ].filter(Boolean).join('\n') + '\n';
    case 'bash':
      return [
        '# omas session rc',
        `[ -f ${bashrc} ] && . ${bashrc}`,
        hook,
        extra,
        tail,
      ].filter(Boolean).join('\n') + '\n';
    case 'fish':
      return ['# omas session rc', hook, extra, tail].filter(Boolean).join('\n') + '\n';
    default:
      return hook ? `${hook}\n` : '';
  }
}

export function sessionShellArgs(shell: string, rcPath: string): string[] {
  switch (shellKind(shell)) {
    case 'zsh':
      // macOS /bin/zsh (5.9) has no --rcfile; load via ZDOTDIR instead.
      return ['-i'];
    case 'bash':
      return ['--rcfile', rcPath, '-i'];
    case 'fish':
      return ['--init-command', fs.readFileSync(rcPath, 'utf8').replace(/\n/g, '; ')];
    default:
      return [];
  }
}

/** Extra env for session rc loading (zsh uses ZDOTDIR). */
export function sessionShellEnv(shell: string, rcDir: string): Record<string, string> {
  if (shellKind(shell) === 'zsh') return { ZDOTDIR: rcDir };
  return {};
}

export function writeSessionRc(tmpDir: string, opts: SessionRcOpts): string | null {
  const base = sessionRcBasename(opts.shell);
  if (!base) return null;
  fs.mkdirSync(tmpDir, { recursive: true });
  const rcPath = path.join(tmpDir, base);
  fs.writeFileSync(rcPath, buildSessionRcContent(opts), { mode: 0o600 });
  return rcPath;
}

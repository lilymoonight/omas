import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildSessionRcContent, sessionShellArgs, shellKind, writeSessionRc } from './cwd-report.js';

/** Claude Code: skip permission prompts in confined sandboxes (requires IS_SANDBOX=1 as root). */
export const CLAUDE_SKIP_PERMISSIONS = '--dangerously-skip-permissions';
/** Cursor agent CLI: auto-approve tool use (same intent as Claude's skip-permissions). */
export const CURSOR_AGENT_YOLO = '--yolo';
/** Qoder CLI: skip permission checks (`--yolo` alias for bypass_permissions). */
export const QODER_YOLO = '--yolo';

const CLAUDE_RE = /(?:^|[\s"'=]|\/)(claude)(?=\s|$)/;
const CURSOR_AGENT_RE = /(?:^|[\s"'=]|\/)(cursor-agent)(?=\s|$)/;
/** Cursor CLI is often installed as bare `agent` (not `cursor-agent`). */
const CURSOR_AGENT_BIN_RE = /(?:^|[\s"'=]|\/)(?<![-\w])(agent)(?=\s|$)/;
const QODERCLI_RE = /(?:^|[\s"'=]|\/)(qodercli)(?=\s|$)/;
const QODER_RE = /(?:^|[\s"'=]|\/)(qoder)(?=\s|$)/;

const SANDBOX_AGENT_BINS: { name: string; flag: string }[] = [
  { name: 'claude', flag: CLAUDE_SKIP_PERMISSIONS },
  { name: 'cursor-agent', flag: CURSOR_AGENT_YOLO },
  { name: 'agent', flag: CURSOR_AGENT_YOLO },
  { name: 'qodercli', flag: QODER_YOLO },
  { name: 'qoder', flag: QODER_YOLO },
];

export function isClaudeInvocation(command: string): boolean {
  return CLAUDE_RE.test(command);
}

export function isCursorAgentInvocation(command: string): boolean {
  return CURSOR_AGENT_RE.test(command) || isCursorAgentBinInvocation(command);
}

export function isCursorAgentBinInvocation(command: string): boolean {
  if (CURSOR_AGENT_RE.test(command)) return false;
  return CURSOR_AGENT_BIN_RE.test(command);
}

export function isQodercliInvocation(command: string): boolean {
  return QODERCLI_RE.test(command);
}

export function isQoderInvocation(command: string): boolean {
  return QODER_RE.test(command);
}

function insertAfterToken(command: string, re: RegExp, flag: string): string {
  if (command.includes(flag)) return command;
  return command.replace(re, (m) => `${m} ${flag}`);
}

/**
 * When a session runs inside the omas filesystem sandbox, agent CLIs often refuse
 * to run or block on permission prompts. Insert the tool-specific bypass flag
 * after the command name when missing (resume commands, `omas exec`, etc.).
 */
export function augmentSandboxAgentCommand(command: string, sandboxed: boolean): string {
  if (!sandboxed) return command;
  let cmd = command;
  if (isClaudeInvocation(cmd)) cmd = insertAfterToken(cmd, CLAUDE_RE, CLAUDE_SKIP_PERMISSIONS);
  if (CURSOR_AGENT_RE.test(cmd)) cmd = insertAfterToken(cmd, CURSOR_AGENT_RE, CURSOR_AGENT_YOLO);
  else if (isCursorAgentBinInvocation(cmd)) cmd = insertAfterToken(cmd, CURSOR_AGENT_BIN_RE, CURSOR_AGENT_YOLO);
  if (isQodercliInvocation(cmd)) cmd = insertAfterToken(cmd, QODERCLI_RE, QODER_YOLO);
  else if (isQoderInvocation(cmd)) cmd = insertAfterToken(cmd, QODER_RE, QODER_YOLO);
  return cmd;
}

/** @deprecated use augmentSandboxAgentCommand */
export const augmentClaudeCommand = augmentSandboxAgentCommand;

export function sandboxAgentShellSupported(shell: string): boolean {
  return shellKind(shell) !== null;
}

/** @deprecated */
export const claudeSandboxShellSupported = sandboxAgentShellSupported;

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Resolve an agent binary using a login-shell-like PATH (LaunchAgent PATH is sparse). */
function resolveAgentBinary(name: string, home: string): string | null {
  const pathParts = [
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    process.env.PATH ?? '',
  ];
  const env = { ...process.env, PATH: pathParts.join(':') };
  try {
    return execFileSync('/usr/bin/which', [name], { env, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Write tiny sh wrappers that exec the real binary with bypass flags (PATH takes precedence). */
export function writeAgentWrapperBinaries(wrapDir: string, home: string): boolean {
  fs.mkdirSync(wrapDir, { recursive: true });
  let wrote = false;
  for (const { name, flag } of SANDBOX_AGENT_BINS) {
    const real = resolveAgentBinary(name, home);
    if (!real) continue;
    const script = ['#!/bin/sh', `exec ${shQuote(real)} ${flag} "$@"`, ''].join('\n');
    fs.writeFileSync(path.join(wrapDir, name), script, { mode: 0o755 });
    wrote = true;
  }
  return wrote;
}

function agentHooksForShell(shell: string, wrapDir: string | null): string {
  const qWrap = wrapDir ? shQuote(wrapDir) : null;
  switch (shellKind(shell)) {
    case 'zsh':
      return [
        qWrap ? `export PATH=${qWrap}:"$PATH"` : '',
        'setopt aliases 2>/dev/null',
        `claude() { command claude ${CLAUDE_SKIP_PERMISSIONS} "$@"; }`,
        `cursor-agent() { command cursor-agent ${CURSOR_AGENT_YOLO} "$@"; }`,
        'unfunction agent 2>/dev/null',
        `agent() { command agent ${CURSOR_AGENT_YOLO} "$@"; }`,
        `qodercli() { command qodercli ${QODER_YOLO} "$@"; }`,
        `qoder() { command qoder ${QODER_YOLO} "$@"; }`,
      ].filter(Boolean).join('\n');
    case 'bash':
      return [
        qWrap ? `export PATH=${qWrap}:"$PATH"` : '',
        `claude() { command claude ${CLAUDE_SKIP_PERMISSIONS} "$@"; }`,
        `cursor-agent() { command cursor-agent ${CURSOR_AGENT_YOLO} "$@"; }`,
        `agent() { command agent ${CURSOR_AGENT_YOLO} "$@"; }`,
        `qodercli() { command qodercli ${QODER_YOLO} "$@"; }`,
        `qoder() { command qoder ${QODER_YOLO} "$@"; }`,
      ].filter(Boolean).join('\n');
    case 'fish':
      return [
        qWrap ? `fish_add_path -m ${qWrap}` : '',
        `function claude --wraps claude; command claude ${CLAUDE_SKIP_PERMISSIONS} $argv; end`,
        `function cursor-agent --wraps cursor-agent; command cursor-agent ${CURSOR_AGENT_YOLO} $argv; end`,
        `function agent --wraps agent; command agent ${CURSOR_AGENT_YOLO} $argv; end`,
        `function qodercli --wraps qodercli; command qodercli ${QODER_YOLO} $argv; end`,
        `function qoder --wraps qoder; command qoder ${QODER_YOLO} $argv; end`,
      ].filter(Boolean).join('\n');
    default:
      return '';
  }
}

export function buildSandboxAgentRcContent(home: string, shell: string, wrapDir?: string | null): string {
  return buildSessionRcContent({ home, shell, extra: agentHooksForShell(shell, wrapDir ?? null) });
}

/** @deprecated */
export const buildClaudeSandboxRcContent = buildSandboxAgentRcContent;

export const sandboxAgentShellArgs = sessionShellArgs;

/** @deprecated */
export const claudeSandboxShellArgs = sandboxAgentShellArgs;

export function writeSandboxAgentRc(tmpDir: string, home: string, shell: string): string | null {
  const wrapDir = path.join(tmpDir, 'omas-bin');
  writeAgentWrapperBinaries(wrapDir, home);
  return writeSessionRc(tmpDir, {
    home,
    shell,
    extra: agentHooksForShell(shell, wrapDir),
  });
}

/** @deprecated */
export const writeClaudeSandboxRc = writeSandboxAgentRc;

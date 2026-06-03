import fs from 'node:fs';
import path from 'node:path';

/** Claude Code: skip permission prompts in confined sandboxes. */
export const CLAUDE_SKIP_PERMISSIONS = '--dangerously-skip-permissions';
/** Cursor agent CLI: auto-approve tool use (same intent as Claude's skip-permissions). */
export const CURSOR_AGENT_YOLO = '--yolo';
/** Qoder CLI: skip permission checks (`--yolo` alias for bypass_permissions). */
export const QODER_YOLO = '--yolo';

const CLAUDE_ALIAS = `alias claude='command claude ${CLAUDE_SKIP_PERMISSIONS}'`;
const CURSOR_AGENT_ALIAS = `alias cursor-agent='command cursor-agent ${CURSOR_AGENT_YOLO}'`;
const CURSOR_AGENT_BIN_ALIAS = `alias agent='command agent ${CURSOR_AGENT_YOLO}'`;
const QODERCLI_ALIAS = `alias qodercli='command qodercli ${QODER_YOLO}'`;
const QODER_ALIAS = `alias qoder='command qoder ${QODER_YOLO}'`;

const CLAUDE_RE = /(?:^|[\s"'=]|\/)(claude)(?=\s|$)/;
const CURSOR_AGENT_RE = /(?:^|[\s"'=]|\/)(cursor-agent)(?=\s|$)/;
/** Cursor CLI is often installed as bare `agent` (not `cursor-agent`). */
const CURSOR_AGENT_BIN_RE = /(?:^|[\s"'=]|\/)(?<![-\w])(agent)(?=\s|$)/;
const QODERCLI_RE = /(?:^|[\s"'=]|\/)(qodercli)(?=\s|$)/;
const QODER_RE = /(?:^|[\s"'=]|\/)(qoder)(?=\s|$)/;

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

function shellKind(shell: string): 'zsh' | 'bash' | 'fish' | null {
  const base = path.basename(shell).toLowerCase();
  if (base.includes('zsh')) return 'zsh';
  if (base.includes('bash')) return 'bash';
  if (base === 'fish') return 'fish';
  return null;
}

export function sandboxAgentShellSupported(shell: string): boolean {
  return shellKind(shell) !== null;
}

/** @deprecated */
export const claudeSandboxShellSupported = sandboxAgentShellSupported;

function agentAliasesForShell(shell: string): string {
  switch (shellKind(shell)) {
    case 'fish':
      return [
        `alias claude 'command claude ${CLAUDE_SKIP_PERMISSIONS}'`,
        `alias cursor-agent 'command cursor-agent ${CURSOR_AGENT_YOLO}'`,
        `alias agent 'command agent ${CURSOR_AGENT_YOLO}'`,
        `alias qodercli 'command qodercli ${QODER_YOLO}'`,
        `alias qoder 'command qoder ${QODER_YOLO}'`,
      ].join('\n');
    default:
      return [CLAUDE_ALIAS, CURSOR_AGENT_ALIAS, CURSOR_AGENT_BIN_ALIAS, QODERCLI_ALIAS, QODER_ALIAS].join('\n');
  }
}

export function buildSandboxAgentRcContent(home: string, shell: string): string {
  const h = shellQuote(home);
  const aliases = agentAliasesForShell(shell);
  switch (shellKind(shell)) {
    case 'zsh':
      return `# omas sandbox (silent)\n[ -f ${h}/.zshrc ] && . ${h}/.zshrc\n${aliases}\n`;
    case 'bash':
      return `# omas sandbox (silent)\n[ -f ${h}/.bashrc ] && . ${h}/.bashrc\n${aliases}\n`;
    case 'fish':
      return `# omas sandbox (silent)\n${aliases}\n`;
    default:
      return `${aliases}\n`;
  }
}

/** @deprecated */
export const buildClaudeSandboxRcContent = buildSandboxAgentRcContent;

export function sandboxAgentShellArgs(shell: string, rcPath: string): string[] {
  switch (shellKind(shell)) {
    case 'zsh':
      return ['--rcfile', rcPath];
    case 'bash':
      return ['--rcfile', rcPath, '-i'];
    case 'fish':
      return ['--init-command', agentAliasesForShell(shell).replace(/\n/g, '; ')];
    default:
      return [];
  }
}

/** @deprecated */
export const claudeSandboxShellArgs = sandboxAgentShellArgs;

export function writeSandboxAgentRc(tmpDir: string, home: string, shell: string): string | null {
  if (!sandboxAgentShellSupported(shell)) return null;
  fs.mkdirSync(tmpDir, { recursive: true });
  const rcPath = path.join(tmpDir, '.omas-agent-rc');
  fs.writeFileSync(rcPath, buildSandboxAgentRcContent(home, shell), { mode: 0o600 });
  return rcPath;
}

/** @deprecated */
export const writeClaudeSandboxRc = writeSandboxAgentRc;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

import fs from 'node:fs';
import path from 'node:path';
import { buildSessionRcContent, sessionShellArgs, shellKind, writeSessionRc } from './cwd-report.js';

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
  return buildSessionRcContent({ home, shell, extra: agentAliasesForShell(shell) });
}

/** @deprecated */
export const buildClaudeSandboxRcContent = buildSandboxAgentRcContent;

export const sandboxAgentShellArgs = sessionShellArgs;

/** @deprecated */
export const claudeSandboxShellArgs = sandboxAgentShellArgs;

export function writeSandboxAgentRc(tmpDir: string, home: string, shell: string): string | null {
  return writeSessionRc(tmpDir, { home, shell, extra: agentAliasesForShell(shell) });
}

/** @deprecated */
export const writeClaudeSandboxRc = writeSandboxAgentRc;

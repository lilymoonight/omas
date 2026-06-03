import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  augmentSandboxAgentCommand,
  buildSandboxAgentRcContent,
  sandboxAgentShellArgs,
  sandboxAgentShellSupported,
  isClaudeInvocation,
  isCursorAgentInvocation,
  isCursorAgentBinInvocation,
  isQodercliInvocation,
  isQoderInvocation,
  writeSandboxAgentRc,
  CLAUDE_SKIP_PERMISSIONS,
  CURSOR_AGENT_YOLO,
  QODER_YOLO,
} from '../src/server/pty/agent-sandbox.js';

describe('agent invocation detection', () => {
  it('matches claude but not claude-code', () => {
    expect(isClaudeInvocation('claude --resume abc')).toBe(true);
    expect(isClaudeInvocation('echo claude-code')).toBe(false);
  });

  it('matches cursor-agent and bare agent but not bare cursor', () => {
    expect(isCursorAgentInvocation('cursor-agent --resume xyz')).toBe(true);
    expect(isCursorAgentInvocation('/usr/local/bin/cursor-agent')).toBe(true);
    expect(isCursorAgentInvocation('agent --resume xyz')).toBe(true);
    expect(isCursorAgentBinInvocation('agent --resume xyz')).toBe(true);
    expect(isCursorAgentBinInvocation('cursor-agent --resume xyz')).toBe(false);
    expect(isCursorAgentInvocation('cursor --resume xyz')).toBe(false);
  });

  it('matches qodercli and bare qoder but not qoder in other tokens', () => {
    expect(isQodercliInvocation('qodercli -r abc')).toBe(true);
    expect(isQodercliInvocation('/usr/local/bin/qodercli')).toBe(true);
    expect(isQoderInvocation('qoder chat')).toBe(true);
    expect(isQoderInvocation('qodercli -r abc')).toBe(false);
    expect(isQoderInvocation('echo qoder-demo')).toBe(false);
  });
});

describe('augmentSandboxAgentCommand', () => {
  it('leaves commands unchanged outside sandbox', () => {
    expect(augmentSandboxAgentCommand('claude --resume x', false)).toBe('claude --resume x');
    expect(augmentSandboxAgentCommand('cursor-agent --resume x', false)).toBe('cursor-agent --resume x');
  });

  it('inserts claude skip-permissions flag', () => {
    expect(augmentSandboxAgentCommand('claude --resume sess-1', true)).toBe(
      `claude ${CLAUDE_SKIP_PERMISSIONS} --resume sess-1`,
    );
  });

  it('inserts cursor-agent --yolo flag', () => {
    expect(augmentSandboxAgentCommand('cursor-agent --resume chat-1', true)).toBe(
      `cursor-agent ${CURSOR_AGENT_YOLO} --resume chat-1`,
    );
  });

  it('inserts bare agent --yolo flag', () => {
    expect(augmentSandboxAgentCommand('agent --resume chat-1', true)).toBe(
      `agent ${CURSOR_AGENT_YOLO} --resume chat-1`,
    );
  });

  it('inserts qodercli --yolo flag', () => {
    expect(augmentSandboxAgentCommand('qodercli -r sess-1', true)).toBe(
      `qodercli ${QODER_YOLO} -r sess-1`,
    );
  });

  it('inserts qoder --yolo flag', () => {
    expect(augmentSandboxAgentCommand('qoder chat', true)).toBe(`qoder ${QODER_YOLO} chat`);
  });

  it('does not double-insert flags', () => {
    expect(augmentSandboxAgentCommand(`claude ${CLAUDE_SKIP_PERMISSIONS} --resume x`, true))
      .toBe(`claude ${CLAUDE_SKIP_PERMISSIONS} --resume x`);
    expect(augmentSandboxAgentCommand(`cursor-agent ${CURSOR_AGENT_YOLO} --resume x`, true))
      .toBe(`cursor-agent ${CURSOR_AGENT_YOLO} --resume x`);
    expect(augmentSandboxAgentCommand(`qodercli ${QODER_YOLO} -r x`, true))
      .toBe(`qodercli ${QODER_YOLO} -r x`);
  });
});

describe('silent sandbox shell setup', () => {
  it('detects supported shells', () => {
    expect(sandboxAgentShellSupported('/bin/zsh')).toBe(true);
    expect(sandboxAgentShellSupported('/bin/sh')).toBe(false);
  });

  it('rc chains user config and aliases all sandbox agents', () => {
    const rc = buildSandboxAgentRcContent('/Users/alice', '/bin/zsh');
    expect(rc).toContain(CLAUDE_SKIP_PERMISSIONS);
    expect(rc).toContain(CURSOR_AGENT_YOLO);
    expect(rc).toContain('cursor-agent');
    expect(rc).toContain("alias agent='command agent");
    expect(rc).toContain('qodercli');
    expect(rc).toContain('qoder');
  });

  it('writes rc under the session tmp dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-rc-'));
    try {
      const rc = writeSandboxAgentRc(dir, '/Users/alice', '/bin/zsh');
      expect(rc).toBe(path.join(dir, '.omas-session-rc'));
      expect(fs.readFileSync(rc!, 'utf8')).toContain('--yolo');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes --rcfile for zsh/bash', () => {
    expect(sandboxAgentShellArgs('/bin/zsh', '/tmp/rc')).toEqual(['--rcfile', '/tmp/rc']);
    expect(sandboxAgentShellArgs('/bin/bash', '/tmp/rc')).toEqual(['--rcfile', '/tmp/rc', '-i']);
  });
});

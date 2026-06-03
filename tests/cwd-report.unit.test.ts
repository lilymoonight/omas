import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSessionRcContent,
  cwdReportHook,
  sessionShellArgs,
  shellKind,
  writeSessionRc,
} from '../src/server/pty/cwd-report.js';

describe('cwd-report', () => {
  it('detects shell kinds', () => {
    expect(shellKind('/bin/zsh')).toBe('zsh');
    expect(shellKind('/usr/local/bin/bash')).toBe('bash');
    expect(shellKind('/opt/homebrew/bin/fish')).toBe('fish');
    expect(shellKind('/bin/sh')).toBeNull();
  });

  it('builds OSC 7 hooks for zsh/bash/fish', () => {
    expect(cwdReportHook('/bin/zsh')).toContain('chpwd_functions');
    expect(cwdReportHook('/bin/bash')).toContain('PROMPT_COMMAND');
    expect(cwdReportHook('/usr/bin/fish')).toContain('--on-variable PWD');
    expect(cwdReportHook('/bin/sh')).toBe('');
  });

  it('writes .omas-session-rc with user rc chain', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-session-rc-'));
    try {
      const rc = writeSessionRc(dir, { home: '/Users/alice', shell: '/bin/zsh' });
      expect(rc).toBe(path.join(dir, '.omas-session-rc'));
      const content = fs.readFileSync(rc!, 'utf8');
      expect(content).toContain('.zshrc');
      expect(content).toContain('__omas_report_cwd');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes shell-specific args', () => {
    expect(sessionShellArgs('/bin/zsh', '/tmp/rc')).toEqual(['--rcfile', '/tmp/rc']);
    expect(sessionShellArgs('/bin/bash', '/tmp/rc')).toEqual(['--rcfile', '/tmp/rc', '-i']);
    expect(sessionShellArgs('/bin/sh', '/tmp/rc')).toEqual([]);
  });

  it('buildSessionRcContent appends extra lines', () => {
    const rc = buildSessionRcContent({
      home: '/home/u',
      shell: '/bin/bash',
      extra: "alias foo='bar'",
    });
    expect(rc).toContain("alias foo='bar'");
    expect(rc).toContain('__omas_report_cwd');
  });
});

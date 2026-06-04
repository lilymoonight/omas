import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSessionRcContent,
  cwdReportHook,
  sessionDirHook,
  sessionShellArgs,
  sessionShellEnv,
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
    expect(cwdReportHook('/bin/zsh')).not.toContain('__omas_report_cwd\n');
    expect(cwdReportHook('/bin/bash')).toContain('PROMPT_COMMAND');
    expect(cwdReportHook('/usr/bin/fish')).toContain('--on-variable PWD');
    expect(cwdReportHook('/bin/sh')).toBe('');
  });

  it('returns to OMAS_SESSION_CWD after user rc', () => {
    const tail = sessionDirHook('/bin/zsh');
    expect(tail).toContain('OMAS_SESSION_CWD');
    expect(tail).toContain('__omas_cd_session');
    const rc = buildSessionRcContent({ home: '/Users/alice', shell: '/bin/zsh' });
    expect(rc).toContain('__omas_cd_session');
    expect(rc.indexOf('__omas_cd_session')).toBeGreaterThan(rc.indexOf('.zshrc'));
  });

  it('writes .zshrc under ZDOTDIR for zsh', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-session-rc-'));
    try {
      const rc = writeSessionRc(dir, { home: '/Users/alice', shell: '/bin/zsh' });
      expect(rc).toBe(path.join(dir, '.zshrc'));
      const content = fs.readFileSync(rc!, 'utf8');
      expect(content).toContain("[ -f '/Users/alice/.zshrc' ] && . '/Users/alice/.zshrc'");
      expect(content).toContain('__omas_report_cwd');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes shell-specific args and env', () => {
    expect(sessionShellArgs('/bin/zsh', '/tmp/rc')).toEqual(['-i']);
    expect(sessionShellEnv('/bin/zsh', '/tmp/rcdir')).toEqual({ ZDOTDIR: '/tmp/rcdir' });
    expect(sessionShellArgs('/bin/bash', '/tmp/rc')).toEqual(['--rcfile', '/tmp/rc', '-i']);
    expect(sessionShellEnv('/bin/bash', '/tmp/rcdir')).toEqual({});
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

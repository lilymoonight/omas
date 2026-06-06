import type { Session } from '../../shared/session.js';
import type { RuntimeInfo } from './api.js';
import { isPathUnder } from './fs-path.js';

export type SandboxBadgeMode = 'off' | 'inside' | 'outside';

export function sandboxBadgeMode(session: Session): SandboxBadgeMode {
  if (!session.sandboxed) return 'off';
  const live = session.liveCwd ?? session.cwd;
  if (isPathUnder(session.cwd, live)) return 'inside';
  return 'outside';
}

/** Live shell cwd — sidebar follows this (read-only dirs outside workspace are browsable). */
export function filesBrowseRoot(session: Session, liveCwd?: string): string {
  return liveCwd ?? session.liveCwd ?? session.cwd;
}

const BADGE_LABEL: Record<SandboxBadgeMode, string> = {
  off: '无沙箱',
  inside: '沙箱内',
  outside: '沙箱外',
};

export function sandboxBadgeLabel(mode: SandboxBadgeMode): string {
  return BADGE_LABEL[mode];
}

export function sandboxBadgeTitle(session: Session, runtime: RuntimeInfo | null): string {
  const lines: string[] = [];
  if (runtime?.sandbox.enabled) {
    lines.push(`沙箱根目录：${runtime.sandbox.root}`);
  }
  lines.push(`工作目录：${session.cwd}`);
  const live = session.liveCwd ?? session.cwd;
  if (normalizeForDisplay(live) !== normalizeForDisplay(session.cwd)) {
    lines.push(`当前目录：${live}`);
  }
  if (sandboxBadgeMode(session) === 'outside') {
    lines.push('当前目录只读；工作目录内可写');
  } else if (sandboxBadgeMode(session) === 'inside') {
    lines.push('当前在工作目录内，可读写');
  } else if (sandboxBadgeMode(session) === 'off') {
    lines.push('此会话未启用文件系统沙箱');
  }
  return lines.join('\n');
}

function normalizeForDisplay(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

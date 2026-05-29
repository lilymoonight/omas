import type { FsEntry, GitFile, GitStatus, HistorySession } from './api.js';
import type { Session } from '../../shared/session.js';

export function fsEntriesEqual(a: FsEntry[], b: FsEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.path !== y.path || x.name !== y.name || x.kind !== y.kind || x.size !== y.size) return false;
  }
  return true;
}

function historyKey(s: HistorySession): string {
  return `${s.source}:${s.id}`;
}

/** Order-insensitive compare — avoids list jump when scan order shifts. */
export function historySessionsEqual(a: HistorySession[], b: HistorySession[]): boolean {
  if (a.length !== b.length) return false;
  const byKey = new Map(b.map((s) => [historyKey(s), s]));
  for (const x of a) {
    const y = byKey.get(historyKey(x));
    if (!y) return false;
    if (
      x.title !== y.title
      || x.cwd !== y.cwd
      || x.cwdExists !== y.cwdExists
      || x.projectName !== y.projectName
      || x.gitBranch !== y.gitBranch
      || x.startedAt !== y.startedAt
      || x.lastActivityAt !== y.lastActivityAt
      || x.messageCount !== y.messageCount
      || x.resumeCommand !== y.resumeCommand
      || x.safeResumeCommand !== y.safeResumeCommand
    ) return false;
  }
  return true;
}

export function sessionsEqual(a: Session[], b: Session[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id
      || x.title !== y.title
      || x.shell !== y.shell
      || x.cwd !== y.cwd
      || x.cols !== y.cols
      || x.rows !== y.rows
      || x.createdAt !== y.createdAt
      || x.lastActivityAt !== y.lastActivityAt
      || x.clientCount !== y.clientCount
      || x.exited !== y.exited
      || x.exitCode !== y.exitCode
      || x.exitSignal !== y.exitSignal
      || x.foreground !== y.foreground
      || x.agent !== y.agent
      || x.agentState !== y.agentState
      || x.liveCwd !== y.liveCwd
    ) return false;
  }
  return true;
}

function gitFilesEqual(a: GitFile[], b: GitFile[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.path !== y.path || x.index !== y.index || x.worktree !== y.worktree || x.oldPath !== y.oldPath) {
      return false;
    }
  }
  return true;
}

export function gitStatusEqual(a: GitStatus | null, b: GitStatus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.available !== b.available) return false;
  if (!a.available && !b.available) {
    return a.reason === b.reason && a.message === b.message && a.cwd === b.cwd;
  }
  if (!a.available || !b.available) return false;
  return (
    a.root === b.root
    && a.cwd === b.cwd
    && a.truncated === b.truncated
    && a.branch.name === b.branch.name
    && a.branch.upstream === b.branch.upstream
    && a.branch.ahead === b.branch.ahead
    && a.branch.behind === b.branch.behind
    && gitFilesEqual(a.files, b.files)
  );
}

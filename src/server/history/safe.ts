import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { HistorySession, HistorySource } from './types.js';

const exec = promisify(execFile);

let cachedAvailable: boolean | null = null;

/** Whether the `ai-safe` sandbox wrapper is installed on PATH. Cached for the
 *  lifetime of the process — it's a deployment-time thing, won't change. */
export async function aiSafeAvailable(): Promise<boolean> {
  if (cachedAvailable !== null) return cachedAvailable;
  try {
    await exec('command', ['-v', 'ai-safe'], { shell: '/bin/bash' as any });
    cachedAvailable = true;
  } catch {
    // Fallback for shells where `command` resolution behaves differently.
    try {
      await exec('which', ['ai-safe']);
      cachedAvailable = true;
    } catch {
      cachedAvailable = false;
    }
  }
  return cachedAvailable;
}

// ai-safe expects: `ai-safe <tool> [project-dir] [-- tool-args...]`. We let the
// shell's cwd (set by the session's `cwd`) act as the implicit project-dir,
// then forward each tool's resume flag verbatim.
const TOOL_NAME: Record<HistorySource, string> = {
  'claude-code': 'claude',
  qoder: 'qoder',
  'cursor-agent': 'cursor',
  opencode: 'opencode',
};
const RESUME_ARG: Record<HistorySource, (id: string) => string> = {
  'claude-code': (id) => `--resume ${id}`,
  qoder:         (id) => `-r ${id}`,
  'cursor-agent': (id) => `--resume ${id}`,
  opencode:      (id) => `--session ${id}`,
};

export function deriveSafeCommand(s: HistorySession): string {
  return `ai-safe ${TOOL_NAME[s.source]} -- ${RESUME_ARG[s.source](s.id)}`;
}

export function annotateSafeCommand(sessions: HistorySession[], available: boolean): HistorySession[] {
  if (!available) return sessions;
  for (const s of sessions) s.safeResumeCommand = deriveSafeCommand(s);
  return sessions;
}

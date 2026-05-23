export type HistorySource = 'claude-code' | 'qoder' | 'cursor-agent' | 'opencode';

export type HistorySession = {
  source: HistorySource;
  id: string;
  cwd: string;
  cwdExists: boolean;
  projectName: string;
  title: string;
  gitBranch: string | null;
  startedAt: string | null;
  lastActivityAt: string;
  messageCount: number;
  /** Shell command we'll auto-type into a new terminal to resume. */
  resumeCommand: string;
  /** Same as resumeCommand but wrapped with `ai-safe` to sandbox the AI tool.
   *  Null when the host doesn't have `ai-safe` on PATH. */
  safeResumeCommand: string | null;
};

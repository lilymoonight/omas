export type Session = {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: string;
  lastActivityAt: string;
  clientCount: number;
  exited: boolean;
  exitCode?: number | null;
  exitSignal?: string | null;
};

export type CreateSessionInput = {
  title?: string;
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  /** Auto-typed once the shell is up (e.g. `claude --resume <id>`). */
  initialCommand?: string;
};

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
  /** True when the shell is confined by a bwrap sandbox (read-only FS outside cwd). */
  sandboxed?: boolean;
  /**
   * Program name running in the foreground of the session's tty (e.g. `vim`,
   * `node`, `top`), or null when the shell itself is at its prompt. Detected by
   * inspecting the process tree; best-effort and may be undefined if unknown.
   */
  foreground?: string | null;
  /** Normalized known AI-agent key when recognized: `claude` | `cursor` | `qoder`. */
  agent?: AgentKey | null;
  /**
   * Activity of the recognized agent, derived from recent PTY output: `active`
   * while it's producing output (working / streaming / spinner), `idle` when
   * quiescent (typically waiting for user input). Only set when `agent` is
   * present; null otherwise.
   */
  agentState?: AgentState | null;
  /**
   * Live working directory of the shell (tracks `cd`), absolute path. Differs
   * from `cwd` (the launch dir) once the user navigates — this is what tells
   * apart multiple agents started from the same default directory.
   */
  liveCwd?: string | null;
};

export type AgentKey = 'claude' | 'cursor' | 'qoder';
export type AgentState = 'active' | 'idle';

export type CreateSessionInput = {
  title?: string;
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  /** Auto-typed once the shell is up (e.g. `claude --resume <id>`). */
  initialCommand?: string;
  /**
   * Sandbox this session (read-only FS outside cwd). Defaults to the server's
   * sandbox policy. Set false to request a full read-write session — which the
   * server only grants when accompanied by a valid `bypass` password.
   */
  sandbox?: boolean;
  /** Bypass password, required only when `sandbox: false` under a sandboxed server. */
  bypass?: string;
};

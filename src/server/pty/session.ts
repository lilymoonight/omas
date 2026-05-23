import { spawn, type IPty } from './backend.js';
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import os from 'node:os';
// @xterm/headless ships CJS (Node interops to ns.default); @xterm/addon-serialize
// MJS only has named exports (Bun resolves to that, no default). Star-import +
// look in both places to satisfy both runtimes from one source file.
import * as headlessNS from '@xterm/headless';
import * as serializeNS from '@xterm/addon-serialize';
const HeadlessTerminal: any =
  (headlessNS as any).Terminal ?? (headlessNS as any).default?.Terminal;
const SerializeAddon: any =
  (serializeNS as any).SerializeAddon ?? (serializeNS as any).default?.SerializeAddon;
type HeadlessTerminal = InstanceType<typeof HeadlessTerminal>;
type SerializeAddon = InstanceType<typeof SerializeAddon>;
import { RingBuffer } from './ring.js';
import { ptyLocaleEnv } from './locale.js';
import type { Session } from '../../shared/session.js';

/** How many lines of scrollback the headless mirror keeps. xterm.js renders
 *  these so the user can scroll up after re-attaching. */
const HEADLESS_SCROLLBACK = 2000;

export type PtySessionOpts = {
  title?: string;
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  scrollbackBytes: number;
  /** Auto-typed once the shell is up (e.g. `claude --resume <id>`). */
  initialCommand?: string;
};

export type PtyEvents = {
  data: (bytes: Buffer) => void;
  exit: (info: { code: number | null; signal: string | null }) => void;
  title: (title: string) => void;
  resize: (cols: number, rows: number) => void;
  clients: (count: number) => void;
};

function pickShell(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.SHELL) return process.env.SHELL;
  return '/bin/bash';
}

export class PtySession extends EventEmitter {
  readonly id = nanoid(10);
  readonly shell: string;
  readonly cwd: string;
  readonly ring: RingBuffer;
  readonly createdAt = new Date();
  readonly clients = new Set<symbol>();
  lastActivityAt = new Date();
  title: string;
  cols: number;
  rows: number;
  exited = false;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  private pty: IPty | null;
  /** Headless xterm instance mirroring the live screen + scrollback state.
   *  Lets us serialize a snapshot on attach so TUI apps (qoder/claude/cursor)
   *  show up intact after a reconnect instead of re-replaying the raw byte
   *  stream which would re-trigger their clear-screen escapes. */
  private readonly headless: HeadlessTerminal;
  private readonly serializer: SerializeAddon;

  get pid(): number | null { return this.pty?.pid ?? null; }

  constructor(opts: PtySessionOpts) {
    super();
    this.shell = pickShell(opts.shell);
    // Default to server's startup cwd — for the agent-development workflow,
    // you cd into your project then launch oh-my-agent-shell and want sessions
    // to land there. Fall back to $HOME if cwd no longer exists.
    this.cwd = opts.cwd ?? process.cwd() ?? os.homedir();
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.title = opts.title ?? this.shell.split('/').pop()!;
    this.ring = new RingBuffer(opts.scrollbackBytes);
    this.headless = new HeadlessTerminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: HEADLESS_SCROLLBACK,
      allowProposedApi: true,
    });
    this.serializer = new SerializeAddon();
    // SerializeAddon's published typings reference @xterm/xterm's Terminal, but
    // at runtime it only touches the buffer API which @xterm/headless also
    // provides. Cast through to satisfy tsc.
    (this.headless as any).loadAddon(this.serializer as any);
    this.pty = spawn(this.shell, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: {
        ...process.env,
        ...ptyLocaleEnv(),
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
      },
    });
    this.pty.onData((buf: Buffer) => {
      this.ring.append(buf);
      // Feed the headless mirror in parallel so a fresh attach can recover
      // the live screen instead of replaying raw bytes (which would re-run
      // TUI clear-screen escapes and destroy the visible state).
      this.headless.write(buf);
      this.lastActivityAt = new Date();
      this.emit('data', buf);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.exitSignal = signal != null ? String(signal) : null;
      this.pty = null;
      try { this.headless.dispose(); } catch { /* */ }
      this.emit('exit', { code: this.exitCode, signal: this.exitSignal });
    });
    if (opts.initialCommand) {
      // Small delay so the shell prints its prompt first; the typed command
      // then appears at the prompt rather than racing it.
      const cmd = opts.initialCommand.endsWith('\n')
        ? opts.initialCommand
        : opts.initialCommand + '\n';
      setTimeout(() => {
        if (!this.exited) this.write(cmd);
      }, 200);
    }
  }

  write(input: string | Buffer): void {
    if (!this.pty) return;
    this.pty.write(typeof input === 'string' ? input : input.toString('utf8'));
    this.lastActivityAt = new Date();
  }

  resize(cols: number, rows: number): void {
    if (!this.pty) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // pty may have just exited; ignore
    }
    try { this.headless.resize(cols, rows); } catch { /* */ }
    this.emit('resize', cols, rows);
  }

  /** Serialize the live screen for attach/reconnect. Scrollback is omitted on
   *  purpose: replaying thousands of scrollback lines leaves the browser
   *  viewport stuck at the top (Cursor/Claude TUI "jumps to ancient history").
   *  The headless mirror still accumulates scrollback for debugging; only
   *  the active buffer is shipped to clients. */
  serializeSnapshot(): { bytes: Buffer; cols: number; rows: number } {
    let s = '';
    try {
      s = this.serializer.serialize({ scrollback: 0 });
    } catch {
      // Headless terminal/serializer can throw on edge cases; fall back to empty.
    }
    return { bytes: Buffer.from(s, 'utf8'), cols: this.cols, rows: this.rows };
  }

  setTitle(title: string): void {
    if (title === this.title) return;
    this.title = title;
    this.emit('title', title);
  }

  attachClient(): symbol {
    const tag = Symbol('client');
    this.clients.add(tag);
    this.emit('clients', this.clients.size);
    return tag;
  }

  detachClient(tag: symbol): void {
    if (this.clients.delete(tag)) {
      this.emit('clients', this.clients.size);
    }
  }

  kill(signal: NodeJS.Signals = 'SIGHUP'): void {
    if (!this.pty) return;
    try {
      this.pty.kill(signal);
    } catch {
      // already dead
    }
  }

  toJSON(): Session {
    return {
      id: this.id,
      title: this.title,
      shell: this.shell,
      cwd: this.cwd,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt.toISOString(),
      lastActivityAt: this.lastActivityAt.toISOString(),
      clientCount: this.clients.size,
      exited: this.exited,
      exitCode: this.exitCode,
      exitSignal: this.exitSignal,
    };
  }
}

export interface PtySession {
  on<K extends keyof PtyEvents>(event: K, listener: PtyEvents[K]): this;
  off<K extends keyof PtyEvents>(event: K, listener: PtyEvents[K]): this;
  emit<K extends keyof PtyEvents>(event: K, ...args: Parameters<PtyEvents[K]>): boolean;
}

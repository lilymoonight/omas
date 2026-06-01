import { spawn, type IPty } from './backend.js';
import { spawn as cpSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import os from 'node:os';
import path from 'node:path';
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
import { resolveSandboxDir, buildSandboxCommand, type SandboxSettings } from './sandbox.js';
import fs from 'node:fs';
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
  /**
   * When set, the shell is wrapped in bubblewrap: the whole filesystem is
   * read-only except `cwd` (which must already be validated to live inside
   * `sandbox.root`). The caller is responsible for that validation; the session
   * defensively re-checks and throws on escape.
   */
  sandbox?: SandboxSettings;
};

export type PtyEvents = {
  data: (bytes: Buffer) => void;
  exit: (info: { code: number | null; signal: string | null }) => void;
  title: (title: string) => void;
  resize: (cols: number, rows: number) => void;
  clients: (count: number) => void;
};

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pickShell(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.SHELL) return process.env.SHELL;
  return '/bin/bash';
}

export class PtySession extends EventEmitter {
  readonly id = nanoid(10);
  readonly shell: string;
  readonly cwd: string;
  /** True when the shell is confined by bubblewrap (read-only FS outside cwd). */
  readonly sandboxed: boolean;
  /** Resolved sandbox parameters (canonical paths), kept so `exec()` can reuse
   *  the exact same confinement as the interactive shell. */
  private readonly sandboxSpec: { writable: string; home: string; tmp: string; net: boolean } | null;
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
  private headlessQueue: Buffer[] = [];
  private headlessTimer: ReturnType<typeof setTimeout> | null = null;
  private snapshotCache: { bytes: Buffer; cols: number; rows: number } | null = null;

  get pid(): number | null { return this.pty?.pid ?? null; }

  constructor(opts: PtySessionOpts) {
    super();
    this.shell = pickShell(opts.shell);
    // Default to server's startup cwd — for the agent-development workflow,
    // you cd into your project then launch oh-my-agent-shell and want sessions
    // to land there. Fall back to $HOME if cwd no longer exists.
    const requestedCwd = opts.cwd ?? process.cwd() ?? os.homedir();

    // Decide spawn target. In sandbox mode we exec `bwrap … -- <shell>`; the
    // session's cwd becomes the (only) writable directory.
    let spawnFile = this.shell;
    let spawnArgs: string[] = [];
    let spawnEnv: Record<string, string> = {};
    if (opts.sandbox) {
      const resolved = resolveSandboxDir(opts.sandbox.root, opts.cwd);
      if (!resolved) {
        throw new Error(`sandbox cwd escapes sandbox root (${opts.sandbox.root})`);
      }
      // Sources must exist before we sandbox them; HOME/TMPDIR live inside the
      // writable dir. Then canonicalize, since the macOS Seatbelt profile matches
      // literal real paths (e.g. /tmp → /private/tmp).
      fs.mkdirSync(resolved.home, { recursive: true });
      fs.mkdirSync(resolved.tmp, { recursive: true });
      const writable = fs.realpathSync(resolved.writable);
      const spec = {
        writable,
        home: path.join(writable, '.home'),
        tmp: path.join(writable, '.tmp'),
        net: opts.sandbox.net,
      };
      this.cwd = writable;
      this.sandboxed = true;
      this.sandboxSpec = spec;
      const cmd = buildSandboxCommand(process.platform, { ...spec, shell: this.shell });
      spawnFile = cmd.file;
      spawnArgs = cmd.args;
      spawnEnv = cmd.env;
    } else {
      this.cwd = requestedCwd;
      this.sandboxed = false;
      this.sandboxSpec = null;
    }
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
    this.pty = spawn(spawnFile, spawnArgs, {
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
        ...spawnEnv,
      },
    });
    this.pty.onData((buf: Buffer) => {
      this.ring.append(buf);
      this.queueHeadless(buf);
      this.lastActivityAt = new Date();
      this.emit('data', buf);
    });
    this.pty.onExit(({ exitCode, signal }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.exitSignal = signal != null ? String(signal) : null;
      this.pty = null;
      this.flushHeadless();
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

  /**
   * Run a one-shot, non-interactive command in this session's working directory
   * (the agent "workspace"), reusing the session's sandbox confinement when set.
   * Stateless: it does NOT share the live shell's process/env — it's a fresh
   * `sh -c <command>`. Output is captured (capped) and returned with the exit
   * status. This is what `omas exec` calls so an external agent can build/test
   * in the workspace and read the result.
   */
  exec(
    command: string,
    opts: { timeoutMs?: number; maxOutputBytes?: number } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; signal: string | null; timedOut: boolean }> {
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 120_000, 1_000), 3_600_000);
    const cap = opts.maxOutputBytes ?? 4 * 1024 * 1024;

    let file: string;
    let args: string[];
    const env = { ...process.env, ...ptyLocaleEnv() } as Record<string, string>;
    if (this.sandboxSpec) {
      const cmd = buildSandboxCommand(process.platform, {
        ...this.sandboxSpec,
        shell: '/bin/sh',
        shellArgs: ['-c', command],
      });
      file = cmd.file;
      args = cmd.args;
      Object.assign(env, cmd.env);
    } else {
      file = '/bin/sh';
      args = ['-c', command];
    }

    return new Promise((resolve) => {
      const child = cpSpawn(file, args, { cwd: this.cwd, env });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outLen = 0;
      let errLen = 0;
      let timedOut = false;
      const push = (bucket: Buffer[], len: number, chunk: Buffer): number => {
        if (len >= cap) return len;
        const room = cap - len;
        bucket.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
        return len + chunk.length;
      };
      child.stdout?.on('data', (c: Buffer) => { outLen = push(out, outLen, c); });
      child.stderr?.on('data', (c: Buffer) => { errLen = push(err, errLen, c); });
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, timeoutMs);
      this.lastActivityAt = new Date();
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ stdout: '', stderr: String((e as Error).message ?? e), exitCode: null, signal: null, timedOut });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.lastActivityAt = new Date();
        resolve({
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
          exitCode: code,
          signal: signal != null ? String(signal) : null,
          timedOut,
        });
      });
    });
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
    this.invalidateSnapshot();
    this.emit('resize', cols, rows);
  }

  private invalidateSnapshot(): void {
    this.snapshotCache = null;
  }

  private queueHeadless(buf: Buffer): void {
    this.headlessQueue.push(buf);
    this.invalidateSnapshot();
    if (!this.headlessTimer) {
      this.headlessTimer = setTimeout(() => this.flushHeadless(), 16);
    }
  }

  private flushHeadless(): void {
    if (this.headlessTimer) {
      clearTimeout(this.headlessTimer);
      this.headlessTimer = null;
    }
    if (this.headlessQueue.length === 0) return;
    const merged = Buffer.concat(this.headlessQueue);
    this.headlessQueue = [];
    try {
      this.headless.write(merged);
    } catch {
      /* headless may be disposed */
    }
  }

  /** Serialize the live screen for attach/reconnect. Scrollback is omitted on
   *  purpose: replaying thousands of scrollback lines leaves the browser
   *  viewport stuck at the top (Cursor/Claude TUI "jumps to ancient history").
   *  The headless mirror still accumulates scrollback for debugging; only
   *  the active buffer is shipped to clients. */
  serializeSnapshot(): { bytes: Buffer; cols: number; rows: number } {
    this.flushHeadless();
    if (
      this.snapshotCache
      && this.snapshotCache.cols === this.cols
      && this.snapshotCache.rows === this.rows
    ) {
      return this.snapshotCache;
    }
    let s = '';
    try {
      s = this.serializer.serialize({ scrollback: 0 });
    } catch {
      // Headless terminal/serializer can throw on edge cases; fall back to empty.
    }
    const result = { bytes: Buffer.from(s, 'utf8'), cols: this.cols, rows: this.rows };
    // `headless.write()` parses asynchronously, so a snapshot taken immediately
    // after a flush can come back empty before the parser has caught up. Caching
    // that empty result would lock it in until the next byte arrives (which may
    // never happen for an idle session). Only cache once we have real content;
    // an empty screen is cheap to re-serialize anyway.
    if (s !== '') this.snapshotCache = result;
    return result;
  }

  /** Snapshot including the full scrollback — used for read-only share viewers
   *  (who join mid-session and want history) and never cached. */
  fullSnapshot(): { bytes: Buffer; cols: number; rows: number } {
    this.flushHeadless();
    let s = '';
    try {
      s = this.serializer.serialize({ scrollback: HEADLESS_SCROLLBACK });
    } catch {
      /* fall back to empty */
    }
    return { bytes: Buffer.from(s, 'utf8'), cols: this.cols, rows: this.rows };
  }

  /** Plain-text dump of the active buffer including scrollback (for export). */
  serializeText(): string {
    this.flushHeadless();
    const buf = (this.headless as any).buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.join('\n') + '\n';
  }

  /** Color-preserving HTML dump including scrollback (for export). Wraps the
   *  addon's clipboard fragment in a full, UTF-8 document with the terminal
   *  block centered on the page. */
  serializeHtml(): string {
    this.flushHeadless();
    let frag = '';
    try {
      frag = this.serializer.serializeAsHTML({ scrollback: HEADLESS_SCROLLBACK, includeGlobalBackground: true });
    } catch {
      return '';
    }
    // serializeAsHTML returns a clipboard fragment:
    //   <html><body><!--StartFragment-->…<!--EndFragment--></body></html>
    const m = frag.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/);
    const inner = m ? m[1] : frag;
    const title = htmlEscape(this.title);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; }
  body { background: #1e1e1e; display: flex; justify-content: center; padding: 24px; box-sizing: border-box; }
  .omas-term { display: inline-block; }
  .omas-term pre { margin: 0; }
</style>
</head>
<body><div class="omas-term">${inner}</div></body>
</html>
`;
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
      sandboxed: this.sandboxed,
    };
  }
}

export interface PtySession {
  on<K extends keyof PtyEvents>(event: K, listener: PtyEvents[K]): this;
  off<K extends keyof PtyEvents>(event: K, listener: PtyEvents[K]): this;
  emit<K extends keyof PtyEvents>(event: K, ...args: Parameters<PtyEvents[K]>): boolean;
}

// macOS PTY backend — uses Bun.spawn({ terminal }) which handles winsize,
// termios, and SIGWINCH correctly. The posix_spawn+ioctl path in
// backend-bun.ts works on Linux but ioctl via bun:ffi is broken on Darwin.

import { EventEmitter } from 'node:events';

export type SpawnOpts = {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
};

export type IPty = {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(cb: (data: Buffer) => void): void;
  onExit(cb: (info: { exitCode: number; signal: number | string }) => void): void;
  write(s: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

type BunTerminal = {
  write(data: string): void;
  resize(cols: number, rows: number): void;
};

type BunPtyProcess = {
  pid: number;
  terminal: BunTerminal;
  kill(code?: number): void;
  exited: Promise<number>;
};

function cleanEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

/** Bun.spawn({ terminal }) ignores `cwd` on macOS — cd after the shell attaches. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function applyCwd(terminal: BunTerminal, cwd: string): void {
  const q = shellQuote(cwd);
  // Small delay so zsh/bash finishes tty setup before consuming the cd line.
  setTimeout(() => {
    try { terminal.write(`cd ${q}\n`); } catch { /* shell may have exited */ }
  }, 50);
}

function killSignal(proc: BunPtyProcess, signal: string): void {
  switch (signal) {
    case 'SIGKILL':
    case '9':
      proc.kill(9);
      break;
    case 'SIGINT':
    case '2':
      proc.kill(2);
      break;
    case 'SIGTERM':
    case '15':
      proc.kill(15);
      break;
    default:
      proc.kill(15);
  }
}

class DarwinPty extends EventEmitter implements IPty {
  readonly pid: number;
  cols: number;
  rows: number;
  private proc: BunPtyProcess;
  private terminal: BunTerminal;
  private exited = false;

  constructor(file: string, args: string[], opts: SpawnOpts) {
    super();
    this.cols = opts.cols;
    this.rows = opts.rows;

    const proc = Bun.spawn([file, ...args], {
      cwd: opts.cwd,
      env: cleanEnv(opts.env),
      terminal: {
        cols: opts.cols,
        rows: opts.rows,
        name: opts.name,
        data: (_term, data) => {
          if (this.exited) return;
          const buf = typeof data === 'string'
            ? Buffer.from(data, 'utf8')
            : Buffer.from(data as ArrayBuffer);
          this.emit('data', buf);
        },
      },
    }) as unknown as BunPtyProcess;

    if (!proc.terminal) throw new Error('Bun.spawn did not provide a terminal');

    this.proc = proc;
    this.terminal = proc.terminal;
    this.pid = proc.pid;

    if (opts.cwd) applyCwd(this.terminal, opts.cwd);

    proc.exited.then((code) => {
      if (this.exited) return;
      this.exited = true;
      this.emit('exit', { exitCode: code, signal: 0 });
    }).catch(() => {
      if (this.exited) return;
      this.exited = true;
      this.emit('exit', { exitCode: 1, signal: 0 });
    });
  }

  onData(cb: (data: Buffer) => void): void { this.on('data', cb); }
  onExit(cb: (info: { exitCode: number; signal: number | string }) => void): void { this.on('exit', cb); }

  write(s: string): void {
    if (this.exited) return;
    try { this.terminal.write(s); } catch { /* */ }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.exited) return;
    try { this.terminal.resize(cols, rows); } catch { /* */ }
  }

  kill(signal: string = 'SIGHUP'): void {
    if (this.exited) return;
    try { killSignal(this.proc, signal); } catch { /* */ }
  }
}

export function spawn(file: string, args: string[], opts: SpawnOpts): IPty {
  return new DarwinPty(file, args, opts);
}

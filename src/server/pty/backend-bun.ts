// Bun PTY backend — implemented end-to-end against libc via bun:ffi.
//
// Key trick: we drive `posix_spawn` ourselves (Bun.spawn doesn't expose
// file_actions / spawn-flags, which is why every other approach we tried
// either silently broke ctty assignment or crashed the runtime).
//
// Spawn recipe — atomic, kernel-side, no JS in the forked child:
//
//   1. open our own pty master/slave pair via posix_openpt + grantpt +
//      unlockpt + open. Slave is opened in the parent only as a sanity
//      anchor (we close it before posix_spawn).
//   2. tcsetattr the slave to a sane Linux cooked termios (ECHO, ICANON,
//      ISIG, IUTF8, …) so bash sees a familiar tty state.
//   3. Build posix_spawn_file_actions_t:
//        - addchdir_np(cwd)   — change to the project dir before exec
//        - addopen(slavePath, O_RDWR /* NO O_NOCTTY */, 0)
//          On a session leader with no current ctty, opening a tty
//          without O_NOCTTY *automatically* installs that tty as the
//          session's controlling terminal. This is the textbook way to
//          set ctty without TIOCSCTTY.
//        - adddup2(0,1), adddup2(0,2) — point stdout/stderr at the same
//          fd so bash sees all three slots as the slave (a real tty).
//   4. Build posix_spawnattr_t:
//        - setflags(POSIX_SPAWN_SETSID) — child becomes a new session
//          leader the instant fork lands, BEFORE any user-space code in
//          the child runs. Combined with step (3), the slave is ctty.
//   5. posix_spawnp(...). Kernel does fork→file_actions→exec atomically.
//   6. In parent, drive I/O via fs streams on the master fd; poll
//      waitpid(WNOHANG) for exit status.
//
// Result: bash starts cleanly. No "cannot set terminal process group"
// warning. Job control (fg/bg/jobs/^Z) actually works.
//
// This file is Bun-only — `bun:ffi` is a runtime built-in. backend.ts
// gates the import behind process.versions.bun.

// @ts-expect-error — bun:ffi is a Bun-only built-in
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';

const isLinux = process.platform === 'linux';
const isDarwin = process.platform === 'darwin';
const libcPath = isDarwin ? 'libSystem.B.dylib' : 'libc.so.6';

// open() flags — O_NOCTTY differs between Linux and Darwin.
const O_RDWR = 0x0002;
const O_NOCTTY = isDarwin ? 0x20000 : 0x0100;

const TIOCSWINSZ = isDarwin ? 0x80087467 : 0x5414;

// posix_spawnattr_setflags: POSIX_SPAWN_SETSID value is platform-specific.
const POSIX_SPAWN_SETSID = isDarwin ? 0x0100 : 0x80;

// waitpid options
const WNOHANG = 1;

// Linux termios bits — chosen to mirror node-pty's defaults.
const LINUX_ICRNL = 0x100, LINUX_IXON = 0x400, LINUX_IUTF8 = 0x4000;
const LINUX_OPOST = 0x1, LINUX_ONLCR = 0x4;
const LINUX_CREAD = 0x80, LINUX_CS8 = 0x30;
const LINUX_ISIG = 0x1, LINUX_ICANON = 0x2, LINUX_ECHO = 0x8, LINUX_ECHOE = 0x10;
const LINUX_ECHOK = 0x20, LINUX_ECHOCTL = 0x200, LINUX_ECHOKE = 0x800, LINUX_IEXTEN = 0x8000;

// Darwin termios.h — struct layout is 4×tcflag + c_cc[20] (no c_line byte).
const DARWIN_ICRNL = 0x00000100, DARWIN_IXON = 0x00000400;
const DARWIN_OPOST = 0x00000001, DARWIN_ONLCR = 0x00000004;
const DARWIN_CREAD = 0x00000800, DARWIN_CS8 = 0x00000300;
const DARWIN_ISIG = 0x00000080, DARWIN_ICANON = 0x00000100, DARWIN_ECHO = 0x00000008;
const DARWIN_ECHOE = 0x00000002, DARWIN_ECHOK = 0x00000004, DARWIN_ECHOCTL = 0x00000200;
const DARWIN_ECHOKE = 0x00000001, DARWIN_IEXTEN = 0x00000400;

// We over-allocate buffers for the opaque structs so we don't have to
// hard-code the libc-specific size. glibc x86_64 is ~80B / ~336B
// respectively today; 1 KiB is wildly safe.
const SPAWN_STRUCT_SIZE = 1024;

const libc = dlopen(libcPath, {
  // pty primitives
  posix_openpt: { args: [FFIType.i32],                                   returns: FFIType.i32 },
  grantpt:      { args: [FFIType.i32],                                   returns: FFIType.i32 },
  unlockpt:     { args: [FFIType.i32],                                   returns: FFIType.i32 },
  ptsname:      { args: [FFIType.i32],                                   returns: FFIType.cstring },
  open:         { args: [FFIType.cstring, FFIType.i32],                  returns: FFIType.i32 },
  close:        { args: [FFIType.i32],                                   returns: FFIType.i32 },
  ioctl:        { args: [FFIType.i32, FFIType.u64, FFIType.ptr],         returns: FFIType.i32 },
  tcsetattr:    { args: [FFIType.i32, FFIType.i32, FFIType.ptr],         returns: FFIType.i32 },
  // posix_spawn family
  posix_spawnp: { args: [FFIType.ptr, FFIType.cstring, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  posix_spawn_file_actions_init:    { args: [FFIType.ptr],                                returns: FFIType.i32 },
  posix_spawn_file_actions_destroy: { args: [FFIType.ptr],                                returns: FFIType.i32 },
  posix_spawn_file_actions_addopen: { args: [FFIType.ptr, FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.u32], returns: FFIType.i32 },
  posix_spawn_file_actions_adddup2: { args: [FFIType.ptr, FFIType.i32, FFIType.i32],      returns: FFIType.i32 },
  posix_spawn_file_actions_addchdir_np: { args: [FFIType.ptr, FFIType.cstring],           returns: FFIType.i32 },
  posix_spawnattr_init:             { args: [FFIType.ptr],                                returns: FFIType.i32 },
  posix_spawnattr_destroy:          { args: [FFIType.ptr],                                returns: FFIType.i32 },
  posix_spawnattr_setflags:         { args: [FFIType.ptr, FFIType.i16],                   returns: FFIType.i32 },
  // wait/signal
  waitpid:      { args: [FFIType.i32, FFIType.ptr, FFIType.i32],         returns: FFIType.i32 },
  kill:         { args: [FFIType.i32, FFIType.i32],                      returns: FFIType.i32 },
});

// ---- helpers --------------------------------------------------------------

function buildCookedTermios(): Uint8Array | null {
  const buf = new Uint8Array(128);
  if (isLinux) {
    const flags = new Uint32Array(buf.buffer, 0, 4);
    flags[0] = LINUX_ICRNL | LINUX_IXON | LINUX_IUTF8;
    flags[1] = LINUX_OPOST | LINUX_ONLCR;
    flags[2] = LINUX_CREAD | LINUX_CS8;
    flags[3] = LINUX_ISIG | LINUX_ICANON | LINUX_ECHO | LINUX_ECHOE | LINUX_ECHOK
      | LINUX_ECHOCTL | LINUX_ECHOKE | LINUX_IEXTEN;
    buf[17 +  0] = 0x03; // VINTR    ^C
    buf[17 +  1] = 0x1c; // VQUIT    ^\
    buf[17 +  2] = 0x7f; // VERASE   DEL
    buf[17 +  3] = 0x15; // VKILL    ^U
    buf[17 +  4] = 0x04; // VEOF     ^D
    buf[17 +  6] = 0x01; // VMIN
    buf[17 +  8] = 0x11; // VSTART   ^Q
    buf[17 +  9] = 0x13; // VSTOP    ^S
    buf[17 + 10] = 0x1a; // VSUSP    ^Z
    buf[17 + 13] = 0x17; // VWERASE  ^W
    buf[17 + 14] = 0x16; // VLNEXT   ^V
    return buf;
  }
  if (isDarwin) {
    const flags = new Uint32Array(buf.buffer, 0, 4);
    flags[0] = DARWIN_ICRNL | DARWIN_IXON;
    flags[1] = DARWIN_OPOST | DARWIN_ONLCR;
    flags[2] = DARWIN_CREAD | DARWIN_CS8;
    flags[3] = DARWIN_ISIG | DARWIN_ICANON | DARWIN_ECHO | DARWIN_ECHOE | DARWIN_ECHOK
      | DARWIN_ECHOCTL | DARWIN_ECHOKE | DARWIN_IEXTEN;
    const cc = 16; // Darwin c_cc starts immediately after the four flag words.
    buf[cc +  0] = 0x03;
    buf[cc +  1] = 0x1c;
    buf[cc +  2] = 0x7f;
    buf[cc +  3] = 0x15;
    buf[cc +  4] = 0x04;
    buf[cc +  6] = 0x01; // VMIN
    buf[cc +  8] = 0x11;
    buf[cc +  9] = 0x13;
    buf[cc + 10] = 0x1a;
    buf[cc + 11] = 0x00; // VTIME
    return buf;
  }
  return null;
}
function buildWinsize(cols: number, rows: number): Uint16Array {
  return new Uint16Array([rows, cols, 0, 0]);
}

function setWinSize(fd: number, cols: number, rows: number): void {
  const ws = buildWinsize(cols, rows);
  libc.symbols.ioctl(fd, TIOCSWINSZ, ptr(ws));
}

const SIGWINCH = 28;

/** Build an argv-style array of C-string pointers, NULL-terminated. The
 *  cstring buffers are anchored on the returned object so they survive
 *  until the caller drops the reference (i.e., after posix_spawn returns). */
function buildCStringArray(strings: string[]): Buffer {
  const cstrings: Buffer[] = strings.map((s) => Buffer.from(s + '\0'));
  const arr = Buffer.alloc((strings.length + 1) * 8);
  for (let i = 0; i < strings.length; i++) {
    arr.writeBigUInt64LE(BigInt(ptr(cstrings[i]!)), i * 8);
  }
  arr.writeBigUInt64LE(0n, strings.length * 8);
  // Anchor the cstrings on the array so GC doesn't reclaim them too early.
  (arr as any).__keepalive = cstrings;
  return arr;
}

function envToArray(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out.push(`${k}=${v}`);
  return out;
}

function openPtyPair(cols: number, rows: number): { master: number; slavePath: string } {
  const master = libc.symbols.posix_openpt(O_RDWR | O_NOCTTY);
  if (master < 0) throw new Error('posix_openpt failed');
  if (libc.symbols.grantpt(master)  < 0) { libc.symbols.close(master); throw new Error('grantpt'); }
  if (libc.symbols.unlockpt(master) < 0) { libc.symbols.close(master); throw new Error('unlockpt'); }
  const slavePath: string = libc.symbols.ptsname(master).toString();
  if (!slavePath) { libc.symbols.close(master); throw new Error('ptsname'); }
  // Open slave once just to set termios; close before spawn so the child's
  // open in posix_spawn is the one that installs ctty.
  const slave = libc.symbols.open(Buffer.from(slavePath + '\0'), O_RDWR | O_NOCTTY);
  if (slave < 0) { libc.symbols.close(master); throw new Error('open(slave)'); }
  const termios = buildCookedTermios();
  if (termios) {
    libc.symbols.tcsetattr(slave, 0 /* TCSANOW */, ptr(termios));
  }
  setWinSize(master, cols, rows);
  libc.symbols.close(slave);
  return { master, slavePath };
}

/** Run the supplied command via posix_spawn with file_actions that
 *  install the slave as ctty in a new session. Returns the child pid. */
function spawnInPty(slavePath: string, cwd: string, file: string, args: string[], env: Record<string, string | undefined>): number {
  const fileActions = new Uint8Array(SPAWN_STRUCT_SIZE);
  const spawnAttr   = new Uint8Array(SPAWN_STRUCT_SIZE);

  if (libc.symbols.posix_spawn_file_actions_init(ptr(fileActions)) !== 0) throw new Error('file_actions_init');
  if (libc.symbols.posix_spawnattr_init(ptr(spawnAttr))            !== 0) {
    libc.symbols.posix_spawn_file_actions_destroy(ptr(fileActions));
    throw new Error('spawnattr_init');
  }

  try {
    // Become a session leader before exec, so the upcoming open of the
    // slave (without O_NOCTTY) installs it as the new session's ctty.
    let rc = libc.symbols.posix_spawnattr_setflags(ptr(spawnAttr), POSIX_SPAWN_SETSID);
    if (rc !== 0) throw new Error('setflags POSIX_SPAWN_SETSID failed: ' + rc);

    // chdir to project dir before everything else (file paths in addopen
    // are resolved AFTER addchdir_np if both are added). Slave path is
    // absolute (/dev/pts/N) so order doesn't actually matter for it.
    rc = libc.symbols.posix_spawn_file_actions_addchdir_np(ptr(fileActions), Buffer.from(cwd + '\0'));
    if (rc !== 0) throw new Error('addchdir_np failed: ' + rc);

    // Open slave as fd 0 — the magic step that installs ctty.
    rc = libc.symbols.posix_spawn_file_actions_addopen(
      ptr(fileActions), 0, Buffer.from(slavePath + '\0'), O_RDWR /* deliberately NO O_NOCTTY */, 0,
    );
    if (rc !== 0) throw new Error('addopen slave failed: ' + rc);

    // Point stdout & stderr at the same slave.
    rc = libc.symbols.posix_spawn_file_actions_adddup2(ptr(fileActions), 0, 1);
    if (rc !== 0) throw new Error('adddup2 1 failed: ' + rc);
    rc = libc.symbols.posix_spawn_file_actions_adddup2(ptr(fileActions), 0, 2);
    if (rc !== 0) throw new Error('adddup2 2 failed: ' + rc);

    const argvArr = buildCStringArray([file, ...args]);
    const envpArr = buildCStringArray(envToArray(env));
    const fileC   = Buffer.from(file + '\0');
    const pidBuf  = new Int32Array(1);

    rc = libc.symbols.posix_spawnp(ptr(pidBuf), fileC, ptr(fileActions), ptr(spawnAttr), ptr(argvArr), ptr(envpArr));
    if (rc !== 0) throw new Error(`posix_spawnp failed: errno=${rc}`);
    return pidBuf[0]!;
  } finally {
    libc.symbols.posix_spawn_file_actions_destroy(ptr(fileActions));
    libc.symbols.posix_spawnattr_destroy(ptr(spawnAttr));
  }
}

// ---- public API -----------------------------------------------------------

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

const SIGNAL_NUM: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGUSR1: 10, SIGUSR2: 12, SIGWINCH: 28,
};
function sigNum(s: string | number): number {
  if (typeof s === 'number') return s;
  return SIGNAL_NUM[s] ?? 15;
}

class BunPty extends EventEmitter implements IPty {
  readonly pid: number;
  cols: number;
  rows: number;
  private masterFd: number;
  private exited = false;
  private readStream: fs.ReadStream | null = null;
  private waitTimer: ReturnType<typeof setInterval> | null = null;

  constructor(file: string, args: string[], opts: SpawnOpts) {
    super();
    this.cols = opts.cols;
    this.rows = opts.rows;

    const { master, slavePath } = openPtyPair(opts.cols, opts.rows);
    this.masterFd = master;
    try {
      this.pid = spawnInPty(slavePath, opts.cwd, file, args, opts.env);
    } catch (err) {
      libc.symbols.close(master);
      throw err;
    }

    this.readStream = fs.createReadStream('', { fd: master, autoClose: false });
    this.readStream.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      this.emit('data', buf);
    });
    this.readStream.on('error', () => { /* EOF/EIO when child dies */ });

    // Poll waitpid(WNOHANG) — Bun.spawn's `proc.exited` Promise isn't
    // available since we did the spawn ourselves. 100 ms is invisible.
    const status = new Int32Array(1);
    this.waitTimer = setInterval(() => {
      if (this.exited) return;
      const rc = libc.symbols.waitpid(this.pid, ptr(status), WNOHANG);
      if (rc === this.pid) {
        const raw = status[0]!;
        // Linux wait status: low 7 bits = signal (0 if normal exit),
        // next 8 bits = exit code (when low 7 are 0).
        const exitCode = (raw & 0x7f) === 0 ? (raw >> 8) & 0xff : raw & 0x7f;
        const signal   = (raw & 0x7f) === 0 ? 0 : (raw & 0x7f);
        this.exited = true;
        if (this.waitTimer) { clearInterval(this.waitTimer); this.waitTimer = null; }
        try { this.readStream?.close(); } catch { /* */ }
        try { libc.symbols.close(this.masterFd); } catch { /* */ }
        this.emit('exit', { exitCode, signal });
      }
    }, 100);
    this.waitTimer.unref?.();
  }

  onData(cb: (data: Buffer) => void): void { this.on('data', cb); }
  onExit(cb: (info: { exitCode: number; signal: number }) => void): void { this.on('exit', cb); }

  write(s: string): void {
    if (this.exited) return;
    try {
      const buf = Buffer.from(s, 'utf8');
      fs.writeSync(this.masterFd, buf, 0, buf.length, null);
    } catch { /* master may be closed */ }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.exited) return;
    try {
      setWinSize(this.masterFd, cols, rows);
      // Ensure shells/tools (zsh, ls, vim) pick up the new geometry.
      libc.symbols.kill(this.pid, SIGWINCH);
    } catch { /* master may be closed */ }
  }

  kill(signal: string = 'SIGHUP'): void {
    if (this.exited) return;
    try { libc.symbols.kill(this.pid, sigNum(signal)); } catch { /* */ }
  }
}

export function spawn(file: string, args: string[], opts: SpawnOpts): IPty {
  return new BunPty(file, args, opts);
}

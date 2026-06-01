// Per-session filesystem sandbox. The whole filesystem is read-only; only the
// session's chosen working directory is writable, so a sandboxed shell (and
// anything it runs — including an agent) can read the box but can only WRITE
// inside that one directory. The writable directory must resolve to within an
// operator-set ceiling (`sandbox root`) so a client can't request `/` and get
// the whole disk back.
//
// Two backends, picked by platform:
//   - Linux  → bubblewrap (`bwrap`): rebinds `/` read-only and the writable dir
//     read-write, with a private tmpfs /tmp.
//   - macOS  → `sandbox-exec` (Seatbelt): a `(deny default)(allow file-read*)`
//     profile that only permits file-write* under the writable dir (+ /dev).
//
// HOME and TMPDIR are pointed at `.home` / `.tmp` inside the writable dir so
// tools can write caches/temp without escaping (on macOS we deny /tmp and
// /var/folders outright, mirroring Linux's isolated tmpfs).
//
// The argv/profile builders are pure (unit-testable on any platform); the actual
// spawn, realpath and availability checks live in session.ts / server.ts.

import path from 'node:path';
import { execFileSync } from 'node:child_process';

export type SandboxSettings = {
  /** Writable ceiling. Every sandboxed session's writable dir must be within it. */
  root: string;
  /** Share the host network (true) or isolate it (false). */
  net: boolean;
  /** Whether new sessions are sandboxed unless explicitly opted out. */
  defaultOn: boolean;
};

export type ResolvedSandbox = { writable: string; home: string; tmp: string; cwd: string };

/**
 * Resolve a per-session writable directory against the sandbox root. The chosen
 * cwd doubles as the (only) writable area; HOME and TMPDIR live under it so tools
 * can write caches/temp without touching the real, read-only $HOME or escaping
 * to /tmp. Returns null when the requested path escapes the root (e.g. `/`, `..`,
 * an unrelated absolute path).
 */
export function resolveSandboxDir(root: string, requestedCwd: string | undefined): ResolvedSandbox | null {
  const absRoot = path.resolve(root);
  // A relative request is taken relative to the root; an absolute one is used as
  // given, then bounds-checked. Either way it must stay within the root.
  const abs = requestedCwd && requestedCwd.trim()
    ? path.resolve(absRoot, requestedCwd)
    : absRoot;
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) return null;
  return { writable: abs, home: path.join(abs, '.home'), tmp: path.join(abs, '.tmp'), cwd: abs };
}

/**
 * Build the bubblewrap argv that wraps `shell`. Whole FS read-only; `writable`
 * rebound read-write; a fresh /dev, /proc and a tmpfs /tmp; HOME pointed at
 * `home` (expected to live under `writable`). The shell starts in `writable`.
 */
export function buildBwrapArgv(opts: {
  writable: string;
  home: string;
  net: boolean;
  shell: string;
  shellArgs?: string[];
  /** Extra device nodes to expose read-write (e.g. /dev/nvidia0 for CUDA). */
  devBinds?: string[];
  /** setsid() for TIOCSTI-injection hardening. Off by default: it detaches the
   *  controlling tty, which can break interactive job control over a PTY. */
  newSession?: boolean;
}): string[] {
  const args: string[] = [
    '--ro-bind', '/', '/', // entire filesystem, read-only
    '--dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    // The single writable area (a later --bind overrides the earlier --ro-bind).
    '--bind', opts.writable, opts.writable,
    '--chdir', opts.writable,
    '--setenv', 'HOME', opts.home,
    '--die-with-parent',
  ];
  for (const dev of opts.devBinds ?? []) args.push('--dev-bind', dev, dev);
  if (!opts.net) args.push('--unshare-net');
  if (opts.newSession) args.push('--new-session');
  args.push('--', opts.shell, ...(opts.shellArgs ?? []));
  return args;
}

/** Escape a path for use inside a double-quoted SBPL string literal. */
function sbplQuote(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a macOS Seatbelt (sandbox-exec) profile: read everything, but only WRITE
 * under `writable` (which contains `.home` and `.tmp`) plus device nodes in /dev.
 * Network is allowed only when `net` is true. `writable` must be a canonical
 * (realpath'd) absolute path — Seatbelt matches literal canonical paths, so
 * /tmp/x won't match the real /private/tmp/x.
 */
export function buildSeatbeltProfile(opts: { writable: string; net: boolean }): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach*)',
    '(allow ipc*)',
    '(allow file-read*)',
    // Terminal ioctls (tcsetattr for ZLE raw mode, tcsetpgrp for job control,
    // window-size, …) are a distinct Seatbelt operation from file-write*. Without
    // this, `(deny default)` blocks them: an interactive shell can't enter raw
    // mode (arrow keys echo as ^[[D) and prints "can't set tty pgrp". Allowing
    // ioctls does not grant write access to file *contents*.
    '(allow file-ioctl)',
    `(allow file-write* (subpath "${sbplQuote(opts.writable)}"))`,
    // Device nodes (the PTY slave, /dev/null, /dev/tty, …) must stay writable or
    // the shell can't talk to its terminal.
    '(allow file-write* (subpath "/dev"))',
  ];
  if (opts.net) lines.push('(allow network*)');
  return lines.join('\n');
}

export type SandboxCommand = { file: string; args: string[]; env: Record<string, string> };

/**
 * Build the platform-specific command that wraps `shell` in a sandbox confining
 * writes to `writable`. Paths are expected canonical (realpath'd by the caller).
 */
export function buildSandboxCommand(
  platform: NodeJS.Platform,
  opts: { writable: string; home: string; tmp: string; net: boolean; shell: string; shellArgs?: string[] },
): SandboxCommand {
  if (platform === 'darwin') {
    const profile = buildSeatbeltProfile({ writable: opts.writable, net: opts.net });
    return {
      file: 'sandbox-exec',
      args: ['-p', profile, opts.shell, ...(opts.shellArgs ?? [])],
      // Keep HOME/TMPDIR inside the writable area (we deny /tmp & /var/folders).
      env: { HOME: opts.home, TMPDIR: opts.tmp },
    };
  }
  // Default: Linux bubblewrap.
  return {
    file: 'bwrap',
    args: buildBwrapArgv({
      writable: opts.writable,
      home: opts.home,
      net: opts.net,
      shell: opts.shell,
      shellArgs: opts.shellArgs,
    }),
    env: { HOME: opts.home },
  };
}

/** True when a sandbox backend is available to actually enforce confinement. */
export function sandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === 'linux') {
      execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
      return true;
    }
    if (platform === 'darwin') {
      // Present on every macOS; confirm it's actually on PATH.
      execFileSync('which', ['sandbox-exec'], { stdio: 'ignore' });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

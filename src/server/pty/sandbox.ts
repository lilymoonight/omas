// Per-session filesystem sandbox. The whole filesystem is read-only; the
// session's chosen working directory AND the operator's real home directory are
// writable, so a sandboxed shell (and anything it runs — including an agent) can
// read the box but only WRITE inside its working dir and the user's home. The
// working dir must resolve to within an operator-set ceiling (`sandbox root`) so
// a client can't request `/` and get the whole disk back.
//
// HOME is the operator's REAL home (not an isolated stub) so agents can read AND
// write their existing config/credentials/state (e.g. ~/.claude, ~/.cursor).
// This is a deliberate trade-off: it widens the writable area beyond the sandbox
// root, but everything outside the working dir and home (system files, /etc,
// other users) stays read-only.
//
// Two backends, picked by platform:
//   - Linux  → bubblewrap (`bwrap`): rebinds `/` read-only, then the working dir
//     and home read-write, with a private tmpfs /tmp.
//   - macOS  → `sandbox-exec` (Seatbelt): a `(deny default)(allow file-read*)`
//     profile that permits file-write* under the working dir, home, and /dev.
//
// TMPDIR is pointed at `.tmp` inside the working dir so tools get a writable temp
// (on macOS we deny /tmp and /var/folders outright; Linux uses an isolated tmpfs).
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

export type ResolvedSandbox = { writable: string; tmp: string; cwd: string };

/**
 * Resolve a per-session working directory against the sandbox root. The chosen
 * cwd is the working writable area; TMPDIR lives under it (`.tmp`) so tools get a
 * writable temp without escaping to the locked-down /tmp. (HOME is the operator's
 * real home, resolved by the caller, not derived here.) Returns null when the
 * requested path escapes the root (e.g. `/`, `..`, an unrelated absolute path).
 */
export function resolveSandboxDir(root: string, requestedCwd: string | undefined): ResolvedSandbox | null {
  const absRoot = path.resolve(root);
  // A relative request is taken relative to the root; an absolute one is used as
  // given, then bounds-checked. Either way it must stay within the root.
  const abs = requestedCwd && requestedCwd.trim()
    ? path.resolve(absRoot, requestedCwd)
    : absRoot;
  if (abs !== absRoot && !abs.startsWith(absRoot + path.sep)) return null;
  return { writable: abs, tmp: path.join(abs, '.tmp'), cwd: abs };
}

/**
 * Build the bubblewrap argv that wraps `shell`. Whole FS read-only; the working
 * dir (`writable`) and the real `home` rebound read-write; a fresh /dev, /proc
 * and a tmpfs /tmp; HOME pointed at `home`. The shell starts in `writable`.
 */
export function buildBwrapArgv(opts: {
  writable: string;
  /** Operator's real home directory — readable and writable so agents can use
   *  their existing config/credentials. */
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
    // The writable areas (a later --bind overrides the earlier --ro-bind): the
    // session working dir and the user's real home.
    '--bind', opts.writable, opts.writable,
    '--bind', opts.home, opts.home,
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
 * under `writable` (the working dir, which contains `.tmp`), the real `home`, and
 * device nodes in /dev. Network is allowed only when `net` is true. `writable`
 * and `home` must be canonical (realpath'd) absolute paths — Seatbelt matches
 * literal canonical paths, so /tmp/x won't match the real /private/tmp/x.
 */
export function buildSeatbeltProfile(opts: { writable: string; home: string; net: boolean }): string {
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
    // setpriority(2)/nice(2): zsh nices background jobs by default (BG_NICE), so
    // oh-my-zsh's async compinit prints "nice(5) failed: operation not permitted"
    // without this. Scheduling priority can't be used to escape the sandbox.
    '(allow system-sched)',
    `(allow file-write* (subpath "${sbplQuote(opts.writable)}"))`,
    // The operator's real home, so agents can write their config/credentials/state.
    `(allow file-write* (subpath "${sbplQuote(opts.home)}"))`,
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
    const profile = buildSeatbeltProfile({ writable: opts.writable, home: opts.home, net: opts.net });
    return {
      file: 'sandbox-exec',
      args: ['-p', profile, opts.shell, ...(opts.shellArgs ?? [])],
      // HOME is the real home (writable via the profile); TMPDIR stays inside the
      // working dir since we deny /tmp & /var/folders.
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

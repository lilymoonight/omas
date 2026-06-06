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
//     and home read-write, with a private tmpfs /tmp. The sandbox keeps the
//     server's uid (including root) so ~/.ssh and other credentials stay usable.
//     `IS_SANDBOX=1` (ai-safe pattern) tells Claude Code the host already
//     confined the session, so `--dangerously-skip-permissions` works as root.
//     When the server runs as root, `--unshare-user` (no uid remap) scopes
//     CAP_SYS_ADMIN so a sandboxed root cannot `mount -o remount,rw` past the
//     read-only binds — same hardening as ai-safe.
//   - macOS  → `sandbox-exec` (Seatbelt): a `(deny default)(allow file-read*)`
//     profile that permits file-write* under the working dir, home, and /dev.
//
// TMPDIR is pointed at `.tmp` inside the working dir so well-behaved tools get an
// isolated writable temp. The system temp dirs stay writable too, though, because
// many tools hardcode /tmp (e.g. Claude Code's shell snapshots / Bash tool) and
// ignore TMPDIR — denying them just broke those tools. Linux gets a private tmpfs
// /tmp; macOS allows the real /private/tmp and /private/var/folders (shared with
// the host, but temp is ephemeral and system files outside stay read-only).
//
// The argv/profile builders are pure (unit-testable on any platform); the actual
// spawn, realpath and availability checks live in session.ts / server.ts.

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { serverIsRoot } from './os-user.js';

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
 * Linux GPU passthrough — same strategy as ai-safe (best_ai/ai-safe):
 * start from bwrap's minimal `--dev /dev`, then overlay host `/dev/nvidia*`
 * with `--dev-bind-try` (skip missing nodes on headless boxes).
 * Block devices (/dev/sda, /dev/nvme, …) are never exposed.
 */
export function discoverGpuDevBinds(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'linux') return [];
  try {
    return fs.readdirSync('/dev')
      .filter((name) => name.startsWith('nvidia'))
      .map((name) => path.join('/dev', name))
      .filter((p) => {
        try { return fs.statSync(p).isCharacterDevice(); } catch { return false; }
      });
  } catch {
    return [];
  }
}

/** macOS Seatbelt rules for Metal / PyTorch MPS / MLX GPU compute inside sandbox-exec. */
export function buildGpuSeatbeltRules(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'darwin') return [];
  // Filesystem allow-list does not grant IOKit/Metal. Minimal surface from
  // production sandboxes (AGX on Apple Silicon + IOGPU fallback on Intel).
  return [
    '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient" "IOGPUDeviceUserClient"))',
    '(allow iokit-get-properties)',
    // Shader JIT (PyTorch MPS, some MLX paths) talks to the compiler service.
    '(allow mach-lookup (global-name "com.apple.MTLCompilerService"))',
  ];
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
  /** Extra device nodes to expose (--dev-bind, must exist). */
  devBinds?: string[];
  /** GPU nodes overlaid on `--dev /dev` via --dev-bind-try (ai-safe pattern). */
  gpuDevBindTry?: string[];
  /** Linux: passthrough the host ssh-agent socket (bwrap uses a private /tmp). */
  sshAuthSock?: string;
  /** setsid() for TIOCSTI-injection hardening. Off by default: it detaches the
   *  controlling tty, which can break interactive job control over a PTY. */
  newSession?: boolean;
  /**
   * Enter a user namespace without uid remap (ai-safe). On a root server this
   * prevents remount-based escapes while keeping host root credentials in $HOME.
   */
  unshareUser?: boolean;
  /** Optional uid/gid remap inside the user namespace (legacy; unused by omas). */
  unprivUid?: number;
  unprivGid?: number;
}): string[] {
  const args: string[] = [];
  const userNs = opts.unshareUser || (opts.unprivUid != null && opts.unprivGid != null);
  if (userNs) args.push('--unshare-user');
  args.push(
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
    // ai-safe: Claude accepts --dangerously-skip-permissions as root when set.
    '--setenv', 'IS_SANDBOX', '1',
    '--die-with-parent',
  );
  if (opts.unprivUid != null && opts.unprivGid != null) {
    args.push('--uid', String(opts.unprivUid), '--gid', String(opts.unprivGid));
  }
  for (const dev of opts.gpuDevBindTry ?? []) args.push('--dev-bind-try', dev, dev);
  for (const dev of opts.devBinds ?? []) args.push('--dev-bind', dev, dev);
  // Host ssh-agent lives outside the private tmpfs /tmp; bind the socket in.
  if (opts.sshAuthSock) args.push('--bind', opts.sshAuthSock, opts.sshAuthSock);
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
    ...(buildGpuSeatbeltRules('darwin')),
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
    // System temp dirs. Mirrors Linux's writable (tmpfs) /tmp: lots of tools —
    // Claude Code's shell snapshots / Bash tool, compilers, package managers —
    // hardcode /tmp or the per-user /var/folders dir and ignore TMPDIR. Denying
    // them broke those tools with "Operation not permitted" on /private/tmp/….
    // Temp is ephemeral; everything else outside the working dir stays read-only.
    // Seatbelt matches canonical paths, so use the /private/* realpaths. These
    // three are the standard temp dirs (/tmp, the per-user $TMPDIR container, and
    // /var/tmp); the rest of /private/var (var/db, var/log, …) stays read-only.
    '(allow file-write* (subpath "/private/tmp"))',
    '(allow file-write* (subpath "/private/var/folders"))',
    '(allow file-write* (subpath "/private/var/tmp"))',
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
  opts: {
    writable: string;
    home: string;
    tmp: string;
    net: boolean;
    shell: string;
    shellArgs?: string[];
    /** Linux: extra /dev nodes (default: auto-discovered GPU devices). */
    devBinds?: string[];
    gpuDevBindTry?: string[];
    sshAuthSock?: string;
    /** Linux: `--unshare-user` without uid remap (default: server runs as root). */
    unshareUser?: boolean;
    /** Legacy uid/gid remap inside the user namespace (unused by omas). */
    unprivUid?: number;
    unprivGid?: number;
  },
): SandboxCommand {
  if (platform === 'darwin') {
    const profile = buildSeatbeltProfile({ writable: opts.writable, home: opts.home, net: opts.net });
    return {
      file: 'sandbox-exec',
      args: ['-p', profile, opts.shell, ...(opts.shellArgs ?? [])],
      // HOME is the real home (writable via the profile); TMPDIR points at the
      // isolated .tmp so compliant tools default there, while the real /tmp stays
      // writable for tools that hardcode it.
      env: { HOME: opts.home, TMPDIR: opts.tmp, IS_SANDBOX: '1' },
    };
  }
  // Default: Linux bubblewrap.
  const gpuDevBindTry = opts.gpuDevBindTry ?? discoverGpuDevBinds('linux');
  const unshareUser = opts.unshareUser ?? serverIsRoot();
  return {
    file: 'bwrap',
    args: buildBwrapArgv({
      writable: opts.writable,
      home: opts.home,
      net: opts.net,
      shell: opts.shell,
      shellArgs: opts.shellArgs,
      gpuDevBindTry,
      devBinds: opts.devBinds,
      sshAuthSock: opts.sshAuthSock,
      unshareUser,
      unprivUid: opts.unprivUid,
      unprivGid: opts.unprivGid,
    }),
    env: { HOME: opts.home, IS_SANDBOX: '1' },
  };
}

/** Bind host ssh-agent socket into a Linux bwrap sandbox (private /tmp otherwise hides it). */
export function resolveSshAuthSockBind(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.SSH_AUTH_SOCK?.trim();
  if (!raw) return undefined;
  try {
    const p = fs.realpathSync(raw);
    return fs.statSync(p).isSocket() || fs.existsSync(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** True when bwrap can use `--unshare-user` (required for root-server sandboxes). */
export function sandboxUserNamespaceAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'linux') return true;
  try {
    execFileSync('bwrap', ['--unshare-user', '--ro-bind', '/', '/', '--', '/bin/true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when a sandbox backend is available to actually enforce confinement. */
export function sandboxAvailable(platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (platform === 'linux') {
      execFileSync('bwrap', ['--version'], { stdio: 'ignore' });
      // Root sandboxes always use --unshare-user; fail fast rather than a false sense of safety.
      if (serverIsRoot() && !sandboxUserNamespaceAvailable(platform)) return false;
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

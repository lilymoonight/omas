import fs from 'node:fs';
import path from 'node:path';
import prompts from 'prompts';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { loadConfig, saveConfig, resolveConfigDir, configPath, makeCookieSecret, type Config } from '../config.js';

export type InitOpts = {
  configDir?: string;
  force?: boolean;
  /** Listen host/port to persist (else prompted; defaults 127.0.0.1 / 7681). */
  host?: string;
  port?: number;
  /** Default working dir for new sessions (persisted as defaultCwd). */
  cwd?: string;
  /** Enable & persist the sandbox with this writable ceiling (else prompted). */
  sandboxRoot?: string;
  /** false → persist sandbox.net=false (isolate net). Undefined leaves default. */
  sandboxNet?: boolean;
  /** false → persist sandbox.default=false (new sessions unsandboxed by default). */
  sandboxDefault?: boolean;
  /** Skip interactive prompts; persist only what's passed via flags. */
  yes?: boolean;
};

export async function runInit(opts: InitOpts): Promise<void> {
  const dir = resolveConfigDir(opts.configDir);
  if (fs.existsSync(configPath(dir)) && !opts.force) {
    console.error(`config already exists at ${configPath(dir)} — pass --force to overwrite`);
    process.exit(1);
  }
  const password = await readPasswordTwice();
  const hash = await hashPassword(password);

  const interactive = !opts.yes && !!process.stdin.isTTY;

  // Listen address. A flag wins; otherwise prompt (interactive) or take the
  // default. Persisting these makes `serve` / the service daemon bind them
  // without any command-line flags.
  let host = opts.host;
  let port = opts.port;
  if (interactive && host == null) {
    const a = await prompts({ type: 'text', name: 'v', message: '监听地址 host', initial: '127.0.0.1' });
    host = typeof a.v === 'string' && a.v.trim() ? a.v.trim() : undefined;
  }
  if (interactive && port == null) {
    const a = await prompts({
      type: 'number',
      name: 'v',
      message: '监听端口 port',
      initial: 7681,
      validate: (n: number) => (n >= 1 && n <= 65535 ? true : '端口需在 1–65535'),
    });
    port = typeof a.v === 'number' ? a.v : undefined;
  }

  // Sandbox writable ceiling. Blank = disabled.
  let sandboxRoot = opts.sandboxRoot;
  if (interactive && sandboxRoot == null) {
    const a = await prompts({
      type: 'text',
      name: 'v',
      message: '沙箱可写根目录 sandbox-root（留空 = 不开启沙箱）',
      initial: '',
    });
    sandboxRoot = typeof a.v === 'string' && a.v.trim() ? a.v.trim() : undefined;
  }

  const config: Config = {
    passwordHash: hash,
    cookieSecret: makeCookieSecret(),
    createdAt: new Date().toISOString(),
  };
  if (host) config.host = host;
  if (port != null) config.port = port;
  if (opts.cwd) config.defaultCwd = path.resolve(opts.cwd);
  if (sandboxRoot) {
    const absRoot = path.resolve(sandboxRoot);
    if (!fs.existsSync(absRoot) || !fs.statSync(absRoot).isDirectory()) {
      console.warn(`! sandbox root does not exist yet: ${absRoot} (create it before starting, or serve will refuse to boot)`);
    }
    config.sandbox = { root: absRoot };
    // Only store the non-default toggles to keep config tidy (both default true).
    if (opts.sandboxNet === false) config.sandbox.net = false;
    if (opts.sandboxDefault === false) config.sandbox.default = false;
  }

  saveConfig(dir, config);
  console.log(`wrote ${configPath(dir)} (mode 0600)`);
  const bits = [`host ${config.host ?? '127.0.0.1'}`, `port ${config.port ?? 7681}`];
  if (config.sandbox) bits.push(`sandbox-root ${config.sandbox.root}`);
  if (config.defaultCwd) bits.push(`cwd ${config.defaultCwd}`);
  console.log(`  ${bits.join(' · ')}`);
  console.log('done. start with: omas serve   (or run it as a service: omas service install)');
}

export async function runPasswd(opts: { configDir?: string; bypass?: boolean }): Promise<void> {
  const dir = resolveConfigDir(opts.configDir);
  const cfg = loadConfig(dir);
  if (!cfg) {
    console.error(`no config at ${configPath(dir)} — run \`init\` first`);
    process.exit(1);
  }

  if (opts.bypass) {
    const password = await readPasswordTwice('sandbox-bypass password (min 6 chars)');
    // The bypass password unlocks full read-write sessions, so it must not be the
    // same secret an agent could already know (the login password).
    if (cfg.passwordHash && (await verifyPassword(cfg.passwordHash, password))) {
      console.error('the bypass password must be different from the login password');
      process.exit(2);
    }
    const hash = await hashPassword(password);
    saveConfig(dir, { ...cfg, unsandboxedHash: hash });
    console.log('sandbox-bypass password set. it is required to create unsandboxed sessions.');
    return;
  }

  const password = await readPasswordTwice();
  const hash = await hashPassword(password);
  saveConfig(dir, { ...cfg, passwordHash: hash });
  console.log('password updated. existing logged-in sessions will keep working until they expire.');
}

export async function readPasswordTwice(message = 'new password (min 6 chars)'): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error('init/passwd require a TTY for interactive password entry');
    process.exit(2);
  }
  const a = await prompts({ type: 'password', name: 'p', message });
  if (typeof a.p !== 'string' || a.p.length < 6) {
    console.error('aborted or password too short');
    process.exit(2);
  }
  const b = await prompts({ type: 'password', name: 'p', message: 'confirm password' });
  if (a.p !== b.p) {
    console.error('passwords do not match');
    process.exit(2);
  }
  return a.p;
}

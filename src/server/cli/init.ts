import fs from 'node:fs';
import prompts from 'prompts';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { loadConfig, saveConfig, resolveConfigDir, configPath, makeCookieSecret } from '../config.js';

export async function runInit(opts: { configDir?: string; force?: boolean }): Promise<void> {
  const dir = resolveConfigDir(opts.configDir);
  if (fs.existsSync(configPath(dir)) && !opts.force) {
    console.error(`config already exists at ${configPath(dir)} — pass --force to overwrite`);
    process.exit(1);
  }
  const password = await readPasswordTwice();
  const hash = await hashPassword(password);
  saveConfig(dir, { passwordHash: hash, cookieSecret: makeCookieSecret(), createdAt: new Date().toISOString() });
  console.log(`wrote ${configPath(dir)} (mode 0600)`);
  console.log('done. start the server with: omas serve');
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

async function readPasswordTwice(message = 'new password (min 6 chars)'): Promise<string> {
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

import fs from 'node:fs';
import prompts from 'prompts';
import { hashPassword } from '../auth/password.js';
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

export async function runPasswd(opts: { configDir?: string }): Promise<void> {
  const dir = resolveConfigDir(opts.configDir);
  const cfg = loadConfig(dir);
  if (!cfg) {
    console.error(`no config at ${configPath(dir)} — run \`init\` first`);
    process.exit(1);
  }
  const password = await readPasswordTwice();
  const hash = await hashPassword(password);
  saveConfig(dir, { ...cfg, passwordHash: hash });
  console.log('password updated. existing logged-in sessions will keep working until they expire.');
}

async function readPasswordTwice(): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error('init/passwd require a TTY for interactive password entry');
    process.exit(2);
  }
  const a = await prompts({ type: 'password', name: 'p', message: 'new password (min 6 chars)' });
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

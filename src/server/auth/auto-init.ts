// Strategy for getting a usable Config when the user runs `serve`:
//
//   1. --password <pw> CLI flag       → memory-only, no disk writes ever
//   2. --password-file <path>         → read file (trimmed), memory only
//   3. OMAS_PASSWORD env var          → memory-only, no disk writes ever
//   4. config.json on disk            → use persisted config (may include password)
//   5. default (no config)            → open mode, no password required
//
// Use `omas init` to persist a password when you want authentication.

import fs from 'node:fs';
import { hashPassword } from './password.js';
import { makeCookieSecret, type Config } from '../config.js';
import { logger } from '../logger.js';

const MIN_LEN = 6;

export type AutoInitOpts = {
  /** Plaintext password from --password flag. Trumps everything; never persisted. */
  passwordInline?: string;
  /** Path to a file containing the password (will be read + trimmed). */
  passwordFile?: string;
};

async function makePasswordConfig(plain: string): Promise<Config> {
  return {
    passwordHash: await hashPassword(plain),
    cookieSecret: makeCookieSecret(),
    createdAt: new Date().toISOString(),
  };
}

function makeOpenConfig(): Config {
  return {
    cookieSecret: makeCookieSecret(),
    createdAt: new Date().toISOString(),
  };
}

/** Returns a Config — uses explicit password sources, else open mode by default. */
export async function autoInitConfig(dir: string, opts: AutoInitOpts = {}): Promise<{ config: Config; persisted: boolean }> {
  if (opts.passwordInline) {
    if (opts.passwordInline.length < MIN_LEN) {
      throw new Error(`--password must be at least ${MIN_LEN} characters`);
    }
    logger.info('使用 --password 命令行参数；密码与 cookie secret 仅在内存中（不落盘）');
    logger.warn('提醒：--password 的值在进程存活期间对同主机用户经 `ps aux` 可见。生产建议改用 --password-file 或 OMAS_PASSWORD');
    return { config: await makePasswordConfig(opts.passwordInline), persisted: false };
  }

  if (opts.passwordFile) {
    let raw: string;
    try { raw = fs.readFileSync(opts.passwordFile, 'utf8'); }
    catch (err) { throw new Error(`无法读取 --password-file ${opts.passwordFile}：${(err as Error).message}`); }
    const pw = raw.replace(/\r?\n$/, '');
    if (pw.length < MIN_LEN) {
      throw new Error(`--password-file 内容长度必须 ≥ ${MIN_LEN}`);
    }
    logger.info({ file: opts.passwordFile }, '从 --password-file 读取密码；仅在内存中（不落盘）');
    return { config: await makePasswordConfig(pw), persisted: false };
  }

  const envPw = process.env.OMAS_PASSWORD;
  if (envPw) {
    if (envPw.length < MIN_LEN) {
      throw new Error(`OMAS_PASSWORD must be at least ${MIN_LEN} characters`);
    }
    logger.info('使用 OMAS_PASSWORD 环境变量；密码与 cookie secret 仅在内存中（不落盘）');
    return { config: await makePasswordConfig(envPw), persisted: false };
  }

  logger.info('未配置密码，以开放模式运行（无需登录）。如需密码请运行 omas init 或使用 --password / OMAS_PASSWORD');
  return { config: makeOpenConfig(), persisted: false };
}

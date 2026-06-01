import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

export const siteSpecSchema = z.object({
  slug: z.string().min(1),
  root: z.string().min(1),
  spa: z.boolean().optional(),
});

export const sandboxConfigSchema = z.object({
  /** Writable ceiling: every sandboxed session's writable dir must be within it. */
  root: z.string().min(1),
  /** Share the host network (true, default) or isolate it (false). */
  net: z.boolean().optional(),
  /** New sessions are sandboxed unless explicitly opted out (default true). */
  default: z.boolean().optional(),
});

export const configSchema = z.object({
  passwordHash: z.string().min(1).optional(),
  cookieSecret: z.string().min(32),
  createdAt: z.string(),
  /** Default directory for new PTY sessions when the client omits cwd. */
  defaultCwd: z.string().min(1).optional(),
  /**
   * Public, no-auth static sites served under /p/<slug>/. Lets the operator
   * publish build output / reports so others can view work results in a browser
   * without the omas password. CLI --publish flags merge on top of these.
   */
  sites: z.array(siteSpecSchema).optional(),
  /**
   * Persistent sandbox settings. May also be supplied via `serve --sandbox-root`
   * (CLI overrides config). When present, new sessions are confined with bwrap so
   * the filesystem is read-only outside the session's chosen working directory.
   */
  sandbox: sandboxConfigSchema.optional(),
  /**
   * Argon2id hash of the "bypass" password required to create an UNSANDBOXED
   * (full read-write) session while sandboxing is enabled. Set only via
   * `omas passwd --bypass` (never a runtime flag, so it can't leak via `ps`).
   * Must differ from the login password and is never sent to agents. When unset,
   * unsandboxed sessions are refused entirely.
   */
  unsandboxedHash: z.string().min(1).optional(),
});
export type Config = z.infer<typeof configSchema>;

/** When false, the web UI and API are open without login. */
export function isAuthRequired(config: Config): boolean {
  return !!config.passwordHash;
}

export function resolveConfigDir(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'oh-my-agent-shell');
  return path.join(os.homedir(), '.config', 'oh-my-agent-shell');
}

export function configPath(dir: string): string {
  return path.join(dir, 'config.json');
}

export function loadConfig(dir: string): Config | null {
  const file = configPath(dir);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return configSchema.parse(raw);
}

export function saveConfig(dir: string, config: Config): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = configPath(dir);
  // 0o600 so the password hash / cookie secret are owner-only
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  // Re-chmod in case the file already existed without the right mode
  fs.chmodSync(file, 0o600);
}

export function makeCookieSecret(): string {
  return randomBytes(32).toString('base64url');
}

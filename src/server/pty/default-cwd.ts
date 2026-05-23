import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../logger.js';

export type DefaultCwdSources = {
  /** CLI --cwd */
  explicit?: string;
  /** OMAS_CWD */
  env?: string;
  /** config.json defaultCwd */
  config?: string;
};

/** Resolve the cwd used when a new session omits `cwd`. */
export function resolveDefaultCwd(sources: DefaultCwdSources = {}): string {
  const raw = sources.explicit ?? sources.env ?? sources.config ?? process.cwd() ?? os.homedir();
  const resolved = path.resolve(raw);
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      logger.warn({ path: resolved }, 'default cwd is not a directory; falling back to $HOME');
      return os.homedir();
    }
  } catch {
    logger.warn({ path: resolved }, 'default cwd does not exist; falling back to $HOME');
    return os.homedir();
  }
  return resolved;
}

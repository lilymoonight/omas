// `install` subcommand — copies THIS process's executable into a directory on
// PATH so the user can invoke `omas` from anywhere without remembering
// ./release/omas. Only makes sense for the single-binary build; under plain
// Node we'd be copying the node interpreter, which is not what anyone wants.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { requireSingleBinary } from './shared.js';

export type InstallOpts = {
  prefix?: string;
  name?: string;
  alias?: string | false;
  force?: boolean;
};

const DEFAULT_NAME = 'omas';

function isWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function pickPrefix(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  // Prefer system-wide if we can write to it; otherwise user-local.
  if (isWritableDir('/usr/local/bin')) return '/usr/local/bin';
  const userBin = path.join(os.homedir(), '.local', 'bin');
  if (isWritableDir(userBin)) return userBin;
  // Last resort — fall back to /usr/local/bin anyway so the error message is
  // actionable ("can't write here, try with sudo").
  return '/usr/local/bin';
}

function inPath(dir: string): boolean {
  const PATH = process.env.PATH ?? '';
  return PATH.split(path.delimiter).some((p) => path.resolve(p) === path.resolve(dir));
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KiB', 'MiB', 'GiB'];
  let v = n / 1024;
  for (const unit of u) { if (v < 1024) return `${v.toFixed(1)} ${unit}`; v /= 1024; }
  return `${v.toFixed(1)} TiB`;
}

export function runInstall(opts: InstallOpts): void {
  const src = requireSingleBinary('install');
  let srcStat: fs.Stats;
  try {
    srcStat = fs.statSync(src);
  } catch (err) {
    console.error(`install: cannot stat self at ${src}: ${(err as Error).message}`);
    process.exit(1);
  }

  const prefix    = pickPrefix(opts.prefix);
  const name      = opts.name  ?? DEFAULT_NAME;
  const aliasName = opts.alias === false || opts.alias === undefined ? null : opts.alias;
  const targetBin   = path.join(prefix, name);
  const targetAlias = aliasName ? path.join(prefix, aliasName) : null;

  // Existing-install / overwrite check.
  if (fs.existsSync(targetBin) && !opts.force) {
    try {
      const existingSelf = fs.realpathSync(targetBin) === fs.realpathSync(src);
      if (existingSelf) {
        console.log(`already installed at ${targetBin} (same binary). nothing to do.`);
        printPathHint(prefix);
        return;
      }
    } catch { /* */ }
    console.error(`install: ${targetBin} already exists. Pass --force to overwrite.`);
    process.exit(1);
  }

  // Writability check up front so we fail fast with a clear message instead
  // of half-copying and hitting EACCES.
  if (!isWritableDir(prefix)) {
    console.error(`install: cannot write to ${prefix}. Try one of:`);
    console.error(`  sudo ${name} install --prefix /usr/local/bin`);
    console.error(`  ${name} install --prefix ~/.local/bin`);
    process.exit(1);
  }

  // Atomic copy: write to a sibling .tmp then rename, so a half-written file
  // never leaves us with a broken binary on PATH.
  const tmp = targetBin + '.tmp-' + process.pid;
  try {
    fs.copyFileSync(src, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, targetBin);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* */ }
    console.error(`install: copy failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // Optional alias as a symlink so updates apply automatically. Fall back to
  // a hard copy if symlinks aren't supported (rare on real filesystems).
  if (targetAlias) {
    try {
      if (fs.existsSync(targetAlias)) fs.unlinkSync(targetAlias);
      fs.symlinkSync(name, targetAlias);
    } catch {
      try { fs.copyFileSync(targetBin, targetAlias); fs.chmodSync(targetAlias, 0o755); } catch { /* skip */ }
    }
  }

  console.log(`installed ${targetBin} (${bytes(srcStat.size)})`);
  if (targetAlias) console.log(`  + alias ${targetAlias} → ${name}`);
  printPathHint(prefix);
}

function printPathHint(dir: string): void {
  if (inPath(dir)) {
    console.log(`\n✓ ${dir} is on your PATH — you can run:`);
    console.log(`    omas serve --port 7681 --password <pw>`);
    return;
  }
  console.log(`\n! ${dir} is NOT on your PATH yet. Add this line to your shell rc:`);
  console.log(`    export PATH="${dir}:$PATH"`);
  console.log(`(then reopen your shell, or run \`source ~/.bashrc\` etc.)`);
}

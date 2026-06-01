import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Loose Fastify shape (matches the other route modules).
type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

/** stat that resolves to null instead of hanging forever on a dead symlink
 *  target (e.g. a stalled network / cloud mount). Async, so a slow entry never
 *  blocks the event loop, plus a hard timeout as a backstop. */
async function statSafe(p: string, timeoutMs = 400): Promise<import('node:fs').Stats | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fsp.stat(p),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Read-only directory listing for the web new-session directory picker. Returns
 * only sub*directories* (the picker only ever targets a cwd). Authed by the
 * global guard — anyone who can reach this already has shell access via the UI,
 * so this exposes nothing they couldn't `ls` themselves.
 *
 * Fully async (incl. symlink resolution) so a slow/dead entry can't block the
 * single-threaded event loop and wedge the whole server.
 */
export function registerDirRoutes(app: App): void {
  app.get('/api/dirs', async (req: any, reply: any) => {
    const raw = typeof req.query?.path === 'string' ? req.query.path.trim() : '';
    let target = raw;
    if (target === '~' || target.startsWith('~/')) target = path.join(os.homedir(), target.slice(1));
    if (!target) target = process.cwd();
    target = path.resolve(target);

    // If `target` isn't itself an existing directory, treat its last segment as a
    // typed prefix and list the parent — gives autocomplete-as-you-type.
    let dir = target;
    let prefix = '';
    const targetStat = await statSafe(target);
    if (!targetStat?.isDirectory()) {
      dir = path.dirname(target);
      prefix = path.basename(target);
    }

    const showHidden = prefix.startsWith('.');
    let dirents: import('node:fs').Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err: any) {
      return reply.code(400).send({ error: 'cannot_list', message: err?.code ?? 'error', dir });
    }

    const candidates = dirents
      .filter((e) => showHidden || !e.name.startsWith('.'))
      .filter((e) => !prefix || e.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 400); // cap stat fan-out

    const entries: { name: string; path: string }[] = [];
    for (const e of candidates) {
      if (entries.length >= 200) break;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        entries.push({ name: e.name, path: abs });
      } else if (e.isSymbolicLink()) {
        const st = await statSafe(abs);
        if (st?.isDirectory()) entries.push({ name: e.name, path: abs });
      }
    }
    return { dir, parent: dir === path.dirname(dir) ? null : path.dirname(dir), entries };
  });
}

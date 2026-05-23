import fsp from 'node:fs/promises';
import { z } from 'zod';
import type { SessionHub } from '../pty/hub.js';
import {
  MAX_EDIT_BYTES,
  MAX_LIST_ENTRIES,
  clampUtf8,
  looksBinary,
  relFromAbs,
  resolveUnderCwd,
  sessionCwd,
  writeFileAtomic,
} from '../pty/fs-util.js';

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  put: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

export type FsEntry = {
  name: string;
  /** Path relative to the shell cwd root. */
  path: string;
  kind: 'file' | 'dir';
  size?: number;
};

const writeSchema = z.object({
  path: z.string().min(1).max(2048),
  content: z.string().max(MAX_EDIT_BYTES),
});

export function registerFsRoutes(app: App, hub: SessionHub): void {
  app.get('/api/sessions/:id/fs/cwd', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const cwd = await sessionCwd(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });
    return { cwd };
  });

  app.get('/api/sessions/:id/fs/list', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const cwd = await sessionCwd(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const relPath = String(req.query?.path ?? '');
    const resolved = resolveUnderCwd(cwd, relPath);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });

    try {
      const stat = await fsp.stat(resolved.abs);
      if (!stat.isDirectory()) return reply.code(400).send({ error: 'not_a_directory' });

      const dirents = await fsp.readdir(resolved.abs, { withFileTypes: true });
      dirents.sort((a, b) => {
        const ad = a.isDirectory() ? 0 : 1;
        const bd = b.isDirectory() ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      let truncated = false;
      const entries: FsEntry[] = [];
      for (const d of dirents) {
        if (d.name === '.omas.tmp' || d.name.startsWith('.omas.tmp.')) continue;
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
        const abs = resolved.abs + '/' + d.name;
        const rel = relFromAbs(cwd, abs);
        if (d.isDirectory()) {
          entries.push({ name: d.name, path: rel, kind: 'dir' });
        } else if (d.isFile()) {
          entries.push({ name: d.name, path: rel, kind: 'file' });
        }
      }

      return { root: cwd, path: resolved.rel, entries, truncated };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return reply.code(404).send({ error: 'not_found' });
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'list_failed', message: String(err?.message ?? err) });
    }
  });

  app.get('/api/sessions/:id/fs/read', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const cwd = await sessionCwd(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const relPath = String(req.query?.path ?? '').trim();
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });

    const resolved = resolveUnderCwd(cwd, relPath);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });

    try {
      const stat = await fsp.stat(resolved.abs);
      if (!stat.isFile()) return reply.code(400).send({ error: 'not_a_file' });
      const raw = await fsp.readFile(resolved.abs);
      if (looksBinary(raw)) {
        return { path: resolved.rel, binary: true, clipped: false, size: raw.length };
      }
      const { text, clipped } = clampUtf8(raw.toString('utf8'), MAX_EDIT_BYTES);
      return { path: resolved.rel, content: text, clipped, binary: false, size: raw.length };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return reply.code(404).send({ error: 'not_found' });
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'read_failed', message: String(err?.message ?? err) });
    }
  });

  app.put('/api/sessions/:id/fs/write', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const cwd = await sessionCwd(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const resolved = resolveUnderCwd(cwd, parsed.data.path);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });
    if (Buffer.byteLength(parsed.data.content, 'utf8') > MAX_EDIT_BYTES) {
      return reply.code(413).send({ error: 'too_large' });
    }
    if (looksBinary(Buffer.from(parsed.data.content, 'utf8'))) {
      return reply.code(400).send({ error: 'binary_not_allowed' });
    }

    try {
      await writeFileAtomic(resolved.abs, parsed.data.content);
      const size = Buffer.byteLength(parsed.data.content, 'utf8');
      return { ok: true, path: resolved.rel, size };
    } catch (err: any) {
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'write_failed', message: String(err?.message ?? err) });
    }
  });
}

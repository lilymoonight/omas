import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SessionHub } from '../pty/hub.js';
import type { UploadStore } from '../pty/upload-store.js';
import {
  MAX_EDIT_BYTES,
  MAX_LIST_ENTRIES,
  MAX_REQUEST_BYTES,
  MAX_UPLOAD_BYTES,
  UPLOAD_CHUNK_BYTES,
  clampUtf8,
  looksBinary,
  relFromAbs,
  resolveUnderCwd,
  sessionCwd,
  uniqueName,
  writeBufferAtomic,
  writeFileAtomic,
} from '../pty/fs-util.js';

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  put: (path: string, handler: (req: any, reply: any) => any) => unknown;
  post: (path: string, handler: (req: any, reply: any) => any) => unknown;
  delete: (path: string, handler: (req: any, reply: any) => any) => unknown;
  addContentTypeParser: (
    contentType: string,
    opts: { parseAs: 'buffer' | 'string'; bodyLimit?: number },
    parser: (req: any, body: Buffer, done: (err: Error | null, body?: Buffer) => void) => void,
  ) => unknown;
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

const uploadQuerySchema = z.object({
  name: z.string().min(1).max(255),
  dir: z.string().max(2048).optional(),
});

const uploadInitSchema = z.object({
  name: z.string().min(1).max(255),
  dir: z.string().max(2048).optional(),
  size: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
});

function safeBasename(name: string): string | null {
  // basename() strips any path components the client may have smuggled in.
  const base = path.basename(name).trim();
  if (!base || base === '.' || base === '..' || base.includes('\0')) return null;
  return base;
}

async function ensureDir(reply: any, cwd: string, relDir: string) {
  const dir = resolveUnderCwd(cwd, relDir);
  if ('error' in dir) {
    reply.code(400).send({ error: dir.error });
    return null;
  }
  try {
    const st = await fsp.stat(dir.abs);
    if (!st.isDirectory()) {
      reply.code(400).send({ error: 'not_a_directory' });
      return null;
    }
  } catch (err: any) {
    if (err?.code === 'ENOENT') reply.code(404).send({ error: 'dir_not_found' });
    else reply.code(500).send({ error: 'stat_failed', message: String(err?.message ?? err) });
    return null;
  }
  return dir;
}

export function registerFsRoutes(app: App, hub: SessionHub, uploads: UploadStore): void {
  // Upload requests send raw bytes with an explicit application/octet-stream
  // content-type. We buffer at most one chunk (or one small single-shot file)
  // in memory per request, so huge files stay bounded.
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_REQUEST_BYTES },
    (_req, body, done) => done(null, body),
  );

  // Single-shot upload for small files (one request, <= MAX_REQUEST_BYTES).
  app.post('/api/sessions/:id/fs/upload', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const parsed = uploadQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query' });

    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'expected_binary_body' });
    if (body.length === 0) return reply.code(400).send({ error: 'empty_file' });
    if (body.length > MAX_REQUEST_BYTES) return reply.code(413).send({ error: 'too_large' });

    const base = safeBasename(parsed.data.name);
    if (!base) return reply.code(400).send({ error: 'bad_name' });

    const cwd = await sessionCwd(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const dir = await ensureDir(reply, cwd, parsed.data.dir ?? '');
    if (!dir) return reply;

    try {
      const finalAbs = await uniqueName(dir.abs, base);
      await writeBufferAtomic(finalAbs, body);
      return {
        ok: true,
        path: relFromAbs(cwd, finalAbs),
        name: path.basename(finalAbs),
        size: body.length,
      };
    } catch (err: any) {
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'upload_failed', message: String(err?.message ?? err) });
    }
  });

  // --- Chunked upload (large files, parallel chunks) ---

  // 1. Reserve a staging file and get an upload id.
  app.post('/api/sessions/:id/fs/upload/init', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const parsed = uploadInitSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const base = safeBasename(parsed.data.name);
    if (!base) return reply.code(400).send({ error: 'bad_name' });

    const cwd = await sessionCwd(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const dir = await ensureDir(reply, cwd, parsed.data.dir ?? '');
    if (!dir) return reply;

    try {
      const { uploadId } = await uploads.begin({
        sessionId: session.id,
        cwd,
        dirAbs: dir.abs,
        name: base,
        size: parsed.data.size,
      });
      return { ok: true, uploadId, chunkSize: UPLOAD_CHUNK_BYTES };
    } catch (err: any) {
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      if (err?.code === 'ENOSPC') return reply.code(507).send({ error: 'no_space' });
      return reply.code(500).send({ error: 'init_failed', message: String(err?.message ?? err) });
    }
  });

  // 2. Write one chunk at the given byte offset (chunks may arrive in parallel).
  app.put('/api/sessions/:id/fs/upload/:uploadId', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const rec = uploads.get(req.params.uploadId, session.id);
    if (!rec) return reply.code(404).send({ error: 'upload_not_found' });

    const offset = Number(req.query?.offset);
    if (!Number.isInteger(offset) || offset < 0) return reply.code(400).send({ error: 'bad_offset' });

    const body: unknown = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'expected_binary_body' });
    if (body.length === 0) return reply.code(400).send({ error: 'empty_chunk' });
    if (offset + body.length > rec.size) return reply.code(400).send({ error: 'out_of_range' });

    try {
      await uploads.writeChunk(rec, offset, body);
      return { ok: true };
    } catch (err: any) {
      if (err?.code === 'ENOSPC') return reply.code(507).send({ error: 'no_space' });
      return reply.code(500).send({ error: 'chunk_failed', message: String(err?.message ?? err) });
    }
  });

  // 3. Finalize: verify all bytes arrived, then atomically rename into place.
  app.post('/api/sessions/:id/fs/upload/:uploadId/complete', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const rec = uploads.get(req.params.uploadId, session.id);
    if (!rec) return reply.code(404).send({ error: 'upload_not_found' });

    if (!uploads.isComplete(rec)) return reply.code(409).send({ error: 'incomplete' });

    try {
      const res = await uploads.finish(rec);
      return { ok: true, ...res };
    } catch (err: any) {
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'complete_failed', message: String(err?.message ?? err) });
    }
  });

  // 4. Abort: drop the staging file (best-effort).
  app.delete('/api/sessions/:id/fs/upload/:uploadId', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const rec = uploads.get(req.params.uploadId, session.id);
    if (rec) await uploads.abort(rec.id);
    return { ok: true };
  });

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

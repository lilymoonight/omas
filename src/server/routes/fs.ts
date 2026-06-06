import fs from 'node:fs';
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
  looksBinary,
  relFromAbs,
  resolveUnderCwd,
  sessionCwd,
  fsBrowseRoot,
  fsBrowseContext,
  sandboxAllowsWrite,
} from '../pty/fs-util.js';
import {
  fsStat,
  fsReaddir,
  fsRead,
  fsWriteText,
  fsUpload,
  spawnAsUser,
  chownToUser,
} from '../pty/fs-priv.js';
import type { OsUserInfo } from '../pty/os-user.js';

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

/** RFC 6266 / 5987 Content-Disposition with a UTF-8 filename* fallback. */
function contentDisposition(name: string): string {
  // ASCII fallback: strip control chars and quotes that would break the header.
  const ascii = name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'download';
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

function safeBasename(name: string): string | null {
  // basename() strips any path components the client may have smuggled in.
  const base = path.basename(name).trim();
  if (!base || base === '.' || base === '..' || base.includes('\0')) return null;
  return base;
}

async function ensureDir(reply: any, osUser: OsUserInfo | null, cwd: string, relDir: string) {
  const dir = resolveUnderCwd(cwd, relDir);
  if ('error' in dir) {
    reply.code(400).send({ error: dir.error });
    return null;
  }
  try {
    const st = await fsStat(osUser, dir.abs);
    if (!st.exists) {
      reply.code(404).send({ error: 'dir_not_found' });
      return null;
    }
    if (!st.isDir) {
      reply.code(400).send({ error: 'not_a_directory' });
      return null;
    }
  } catch (err: any) {
    if (err?.code === 'EACCES') reply.code(403).send({ error: 'permission_denied' });
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

    const dir = await ensureDir(reply, session.osUserInfo, cwd, parsed.data.dir ?? '');
    if (!dir) return reply;
    if (!sandboxAllowsWrite(session, dir.abs)) {
      return reply.code(403).send({ error: 'read_only_outside_workspace' });
    }

    try {
      const { finalAbs, size } = await fsUpload(session.osUserInfo, dir.abs, base, body);
      return {
        ok: true,
        path: relFromAbs(cwd, finalAbs),
        name: path.basename(finalAbs),
        size,
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

    const dir = await ensureDir(reply, session.osUserInfo, cwd, parsed.data.dir ?? '');
    if (!dir) return reply;
    if (!sandboxAllowsWrite(session, dir.abs)) {
      return reply.code(403).send({ error: 'read_only_outside_workspace' });
    }

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
      // Chunked staging is written by the (root) server; hand the finished file
      // to the session's UNIX user so they own what they uploaded (Model B).
      if (session.osUserInfo) {
        try {
          await chownToUser(session.osUserInfo, path.join(rec.dirAbs, res.name));
        } catch { /* best-effort: file exists, ownership fix-up failed */ }
      }
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
    const ctx = await fsBrowseContext(session);
    if (!ctx.root) return reply.code(404).send({ error: 'no_cwd' });
    return {
      cwd: ctx.root,
      liveCwd: ctx.liveCwd ?? undefined,
      workspace: ctx.workspace ?? undefined,
      sandboxed: session.sandboxed || undefined,
      readOnly: ctx.readOnly || undefined,
    };
  });

  app.get('/api/sessions/:id/fs/list', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const cwd = await fsBrowseRoot(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const relPath = String(req.query?.path ?? '');
    const resolved = resolveUnderCwd(cwd, relPath);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });

    try {
      const stat = await fsStat(session.osUserInfo, resolved.abs);
      if (!stat.exists) return reply.code(404).send({ error: 'not_found' });
      if (!stat.isDir) return reply.code(400).send({ error: 'not_a_directory' });

      const { entries: dirents, truncated: workerTruncated } = await fsReaddir(session.osUserInfo, resolved.abs);
      dirents.sort((a, b) => {
        const ad = a.isDir ? 0 : 1;
        const bd = b.isDir ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

      let truncated = workerTruncated;
      const entries: FsEntry[] = [];
      for (const d of dirents) {
        if (d.name === '.omas.tmp' || d.name.startsWith('.omas.tmp.')) continue;
        if (entries.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          break;
        }
        const abs = resolved.abs + '/' + d.name;
        const rel = relFromAbs(cwd, abs);
        if (d.isDir) {
          entries.push({ name: d.name, path: rel, kind: 'dir' });
        } else if (d.isFile) {
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

    const cwd = await fsBrowseRoot(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const relPath = String(req.query?.path ?? '').trim();
    if (!relPath) return reply.code(400).send({ error: 'bad_path' });

    const resolved = resolveUnderCwd(cwd, relPath);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });

    try {
      const stat = await fsStat(session.osUserInfo, resolved.abs);
      if (!stat.exists) return reply.code(404).send({ error: 'not_found' });
      if (!stat.isFile) return reply.code(400).send({ error: 'not_a_file' });
      const r = await fsRead(session.osUserInfo, resolved.abs);
      if (r.binary) return { path: resolved.rel, binary: true, clipped: false, size: r.size };
      return { path: resolved.rel, content: r.content, clipped: r.clipped, binary: false, size: r.size };
    } catch (err: any) {
      if (err?.code === 'ENOENT') return reply.code(404).send({ error: 'not_found' });
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'read_failed', message: String(err?.message ?? err) });
    }
  });

  // Download a single file (streamed verbatim) or a directory (streamed as a
  // gzip-compressed tar built by the system `tar`, so we add no archive deps and
  // keep memory flat regardless of size). Path traversal is bounded by cwd.
  app.get('/api/sessions/:id/fs/download', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const cwd = await fsBrowseRoot(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const relPath = String(req.query?.path ?? '');
    const resolved = resolveUnderCwd(cwd, relPath);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });

    let stat: { exists: boolean; isFile: boolean; isDir: boolean; size: number };
    try {
      stat = await fsStat(session.osUserInfo, resolved.abs);
    } catch (err: any) {
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'stat_failed', message: String(err?.message ?? err) });
    }
    if (!stat.exists) return reply.code(404).send({ error: 'not_found' });

    if (stat.isDir) {
      const baseName = path.basename(resolved.abs) || 'root';
      const parent = path.dirname(resolved.abs);
      // tar runs as the session's UNIX user (Model B) so it only archives files
      // that user can read.
      const child = spawnAsUser(session.osUserInfo, 'tar', ['-czf', '-', '-C', parent, baseName]);
      let failed = false;
      child.on('error', (err) => {
        failed = true;
        if (!reply.sent) reply.code(500).send({ error: 'tar_unavailable', message: String(err?.message ?? err) });
        else child.kill('SIGKILL');
      });
      // Give `tar` a tick to fail fast (e.g. not installed) before we commit headers.
      await new Promise((r) => setImmediate(r));
      if (failed) return reply;
      reply.header('content-type', 'application/gzip');
      reply.header('content-disposition', contentDisposition(`${baseName}.tar.gz`));
      reply.header('cache-control', 'no-store');
      return reply.send(child.stdout);
    }

    if (!stat.isFile) return reply.code(400).send({ error: 'not_a_file' });

    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(stat.size));
    reply.header('content-disposition', contentDisposition(path.basename(resolved.abs)));
    reply.header('cache-control', 'no-store');
    // For an OS-user session, stream the bytes via a privilege-dropped `cat` so
    // the read is performed as that user; otherwise read directly (root/single).
    if (session.osUserInfo) {
      const child = spawnAsUser(session.osUserInfo, 'cat', ['--', resolved.abs]);
      child.on('error', () => {
        if (!reply.sent) reply.code(500).send({ error: 'read_failed' });
      });
      return reply.send(child.stdout);
    }
    return reply.send(fs.createReadStream(resolved.abs));
  });

  app.put('/api/sessions/:id/fs/write', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });

    const parsed = writeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });

    const cwd = await fsBrowseRoot(session);
    if (!cwd) return reply.code(404).send({ error: 'no_cwd' });

    const resolved = resolveUnderCwd(cwd, parsed.data.path);
    if ('error' in resolved) return reply.code(400).send({ error: resolved.error });
    if (!sandboxAllowsWrite(session, resolved.abs)) {
      return reply.code(403).send({ error: 'read_only_outside_workspace' });
    }
    if (Buffer.byteLength(parsed.data.content, 'utf8') > MAX_EDIT_BYTES) {
      return reply.code(413).send({ error: 'too_large' });
    }
    if (looksBinary(Buffer.from(parsed.data.content, 'utf8'))) {
      return reply.code(400).send({ error: 'binary_not_allowed' });
    }

    try {
      const { size } = await fsWriteText(session.osUserInfo, resolved.abs, parsed.data.content);
      return { ok: true, path: resolved.rel, size };
    } catch (err: any) {
      if (err?.code === 'EACCES') return reply.code(403).send({ error: 'permission_denied' });
      return reply.code(500).send({ error: 'write_failed', message: String(err?.message ?? err) });
    }
  });
}

import fsp from 'node:fs/promises';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { relFromAbs, uniqueName } from './fs-util.js';

export type UploadInit = {
  sessionId: string;
  cwd: string;
  dirAbs: string;
  name: string;
  size: number;
};

export type UploadRec = {
  id: string;
  sessionId: string;
  cwd: string;
  dirAbs: string;
  name: string;
  size: number;
  tmpPath: string;
  /** offset -> byte length written (idempotent on retry). */
  chunks: Map<number, number>;
  lastActivity: number;
};

const STALE_MS = 30 * 60 * 1000;

/**
 * Tracks in-progress chunked uploads. Each upload streams into a preallocated
 * `.omas.tmp.<id>` file in the target directory; chunks are written at their
 * byte offset (so they can arrive in parallel / out of order) and the file is
 * atomically renamed into place on completion.
 */
export class UploadStore {
  private recs = new Map<string, UploadRec>();
  private sweeper: ReturnType<typeof setInterval>;

  constructor() {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  async begin(init: UploadInit): Promise<{ uploadId: string; tmpPath: string }> {
    const id = nanoid();
    const tmpPath = path.join(init.dirAbs, `.omas.tmp.${id}`);
    const fh = await fsp.open(tmpPath, 'w');
    try {
      if (init.size > 0) await fh.truncate(init.size);
    } finally {
      await fh.close();
    }
    this.recs.set(id, {
      id,
      sessionId: init.sessionId,
      cwd: init.cwd,
      dirAbs: init.dirAbs,
      name: init.name,
      size: init.size,
      tmpPath,
      chunks: new Map(),
      lastActivity: Date.now(),
    });
    return { uploadId: id, tmpPath };
  }

  /** Returns the record only if it exists and belongs to the given session. */
  get(id: string, sessionId: string): UploadRec | null {
    const rec = this.recs.get(id);
    if (!rec || rec.sessionId !== sessionId) return null;
    return rec;
  }

  async writeChunk(rec: UploadRec, offset: number, buf: Buffer): Promise<void> {
    // Fresh fd per chunk → independent positional writes, safe under concurrency.
    const fh = await fsp.open(rec.tmpPath, 'r+');
    try {
      await fh.write(buf, 0, buf.length, offset);
    } finally {
      await fh.close();
    }
    rec.chunks.set(offset, buf.length);
    rec.lastActivity = Date.now();
  }

  /** True when received chunks cover [0, size) contiguously with no gaps. */
  isComplete(rec: UploadRec): boolean {
    if (rec.size === 0) return true;
    const ordered = [...rec.chunks.entries()].sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const [off, len] of ordered) {
      if (off !== cursor) return false;
      cursor += len;
    }
    return cursor === rec.size;
  }

  async finish(rec: UploadRec): Promise<{ path: string; name: string; size: number }> {
    const finalAbs = await uniqueName(rec.dirAbs, rec.name);
    await fsp.rename(rec.tmpPath, finalAbs);
    this.recs.delete(rec.id);
    return {
      path: relFromAbs(rec.cwd, finalAbs),
      name: path.basename(finalAbs),
      size: rec.size,
    };
  }

  async abort(id: string): Promise<void> {
    const rec = this.recs.get(id);
    if (!rec) return;
    this.recs.delete(id);
    try {
      await fsp.unlink(rec.tmpPath);
    } catch {
      /* already gone */
    }
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const rec of [...this.recs.values()]) {
      if (now - rec.lastActivity > STALE_MS) await this.abort(rec.id);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweeper);
    for (const rec of [...this.recs.values()]) await this.abort(rec.id);
  }
}

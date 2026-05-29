import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UploadStore } from '../src/server/pty/upload-store.js';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), 'omas-up-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe('UploadStore', () => {
  it('assembles out-of-order chunks into the final file', async () => {
    const store = new UploadStore();
    try {
      const dir = await tmp();
      const payload = Buffer.from('hello chunked world — 你好分片世界', 'utf8');
      const { uploadId } = await store.begin({
        sessionId: 's1',
        cwd: dir,
        dirAbs: dir,
        name: 'note.txt',
        size: payload.length,
      });

      const rec = store.get(uploadId, 's1');
      expect(rec).not.toBeNull();

      // Write the second half first, then the first half.
      const mid = Math.floor(payload.length / 2);
      expect(store.isComplete(rec!)).toBe(false);
      await store.writeChunk(rec!, mid, payload.subarray(mid));
      expect(store.isComplete(rec!)).toBe(false);
      await store.writeChunk(rec!, 0, payload.subarray(0, mid));
      expect(store.isComplete(rec!)).toBe(true);

      const res = await store.finish(rec!);
      expect(res.name).toBe('note.txt');
      expect(res.size).toBe(payload.length);
      const written = await readFile(path.join(dir, 'note.txt'));
      expect(written.equals(payload)).toBe(true);
    } finally {
      await store.shutdown();
    }
  });

  it('treats duplicate chunk offsets idempotently', async () => {
    const store = new UploadStore();
    try {
      const dir = await tmp();
      const buf = Buffer.alloc(10, 0x41);
      const { uploadId } = await store.begin({ sessionId: 's', cwd: dir, dirAbs: dir, name: 'a.bin', size: 10 });
      const rec = store.get(uploadId, 's')!;
      await store.writeChunk(rec, 0, buf.subarray(0, 6));
      await store.writeChunk(rec, 0, buf.subarray(0, 6)); // retry same offset
      expect(store.isComplete(rec)).toBe(false);
      await store.writeChunk(rec, 6, buf.subarray(6));
      expect(store.isComplete(rec)).toBe(true);
      await store.finish(rec);
      expect((await stat(path.join(dir, 'a.bin'))).size).toBe(10);
    } finally {
      await store.shutdown();
    }
  });

  it('avoids overwriting an existing file by suffixing the name', async () => {
    const store = new UploadStore();
    try {
      const dir = await tmp();
      const data = Buffer.from('x');
      for (const _ of [0, 1]) {
        const { uploadId } = await store.begin({ sessionId: 's', cwd: dir, dirAbs: dir, name: 'dup.txt', size: 1 });
        const rec = store.get(uploadId, 's')!;
        await store.writeChunk(rec, 0, data);
        await store.finish(rec);
      }
      const names = (await readdir(dir)).sort();
      expect(names).toContain('dup.txt');
      expect(names).toContain('dup (1).txt');
    } finally {
      await store.shutdown();
    }
  });

  it('rejects access from a different session and cleans up on abort', async () => {
    const store = new UploadStore();
    try {
      const dir = await tmp();
      const { uploadId } = await store.begin({ sessionId: 'owner', cwd: dir, dirAbs: dir, name: 'f', size: 4 });
      expect(store.get(uploadId, 'intruder')).toBeNull();
      expect(store.get(uploadId, 'owner')).not.toBeNull();
      await store.abort(uploadId);
      expect(store.get(uploadId, 'owner')).toBeNull();
      const leftover = (await readdir(dir)).filter((n) => n.startsWith('.omas.tmp.'));
      expect(leftover).toEqual([]);
    } finally {
      await store.shutdown();
    }
  });
});

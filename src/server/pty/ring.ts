// Per-session scrollback ring. Stores raw PTY bytes keyed by monotonic seq.
// Trim from the head when the byte budget is exceeded.
//
// PTY chunks may split UTF-8 code points; trim/slice only on code-point boundaries
// so replay does not inject U+FFFD (�) into CJK or box-drawing text.

import { alignUtf8Start, stripLeadingPartialUtf8 } from './utf8-bytes.js';

export class RingBuffer {
  private chunks: Array<{ start: number; bytes: Buffer }> = [];
  private totalBytes = 0;
  private head = 0; // next seq to assign
  private oldest = 0; // smallest seq still represented

  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error('capacity must be > 0');
  }

  get currentSeq(): number {
    return this.head;
  }

  append(bytes: Buffer): number {
    if (bytes.length === 0) return this.head;
    const start = this.head;
    this.chunks.push({ start, bytes });
    this.totalBytes += bytes.length;
    this.head += bytes.length;
    this.trim();
    return this.head;
  }

  private trim(): void {
    while (this.totalBytes > this.capacity && this.chunks.length > 0) {
      const drop = this.chunks.shift()!;
      this.totalBytes -= drop.bytes.length;
      this.oldest = drop.start + drop.bytes.length;
      this.normalizeHead();
    }
  }

  /** After head eviction, drop orphaned UTF-8 continuation bytes at chunk front. */
  private normalizeHead(): void {
    while (this.chunks.length > 0) {
      const cur = this.chunks[0]!;
      const trimmed = stripLeadingPartialUtf8(cur.bytes);
      if (trimmed.length === cur.bytes.length) break;
      const skip = cur.bytes.length - trimmed.length;
      if (trimmed.length === 0) {
        this.chunks.shift();
        this.totalBytes -= cur.bytes.length;
        this.oldest = cur.start + cur.bytes.length;
        continue;
      }
      this.chunks[0] = { start: cur.start + skip, bytes: trimmed };
      this.totalBytes -= skip;
      this.oldest += skip;
      break;
    }
  }

  /**
   * Return all bytes with seq > `since`. If `since` is older than what we still hold,
   * dump the whole buffer and flag truncated:true.
   */
  since(since: number): { bytes: Buffer; seq: number; truncated: boolean } {
    const truncated = since < this.oldest;
    const effectiveSince = truncated ? this.oldest : since;
    if (effectiveSince >= this.head) {
      return { bytes: Buffer.alloc(0), seq: this.head, truncated };
    }
    const parts: Buffer[] = [];
    for (const c of this.chunks) {
      const cEnd = c.start + c.bytes.length;
      if (cEnd <= effectiveSince) continue;
      if (c.start >= effectiveSince) {
        parts.push(c.bytes);
      } else {
        const local = effectiveSince - c.start;
        const aligned = alignUtf8Start(c.bytes, local);
        parts.push(c.bytes.subarray(aligned));
      }
    }
    return { bytes: Buffer.concat(parts), seq: this.head, truncated };
  }
}

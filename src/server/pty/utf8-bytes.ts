/** UTF-8 helpers for byte buffers (PTY output is untyped bytes, not Unicode). */

export function isUtf8Continuation(b: number): boolean {
  return (b & 0xc0) === 0x80;
}

/** Move `off` forward to the next code-point boundary (never moves backward). */
export function alignUtf8Start(buf: Buffer, off: number): number {
  while (off < buf.length && isUtf8Continuation(buf[off]!)) off++;
  return off;
}

/** Drop orphaned continuation bytes at the front; returns bytes unchanged if already aligned. */
export function stripLeadingPartialUtf8(buf: Buffer): Buffer {
  const off = alignUtf8Start(buf, 0);
  return off === 0 ? buf : buf.subarray(off);
}

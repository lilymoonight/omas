/** Coalesce bursty PTY frames into one xterm write per animation frame. */
export type TermWriteBatch = {
  push(chunk: Uint8Array, onFlushed?: () => void): void;
  flush(): void;
  dispose(): void;
};

export function concatUint8(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function createTermWriteBatch(
  write: (data: Uint8Array, callback?: () => void) => void,
): TermWriteBatch {
  let queue: Uint8Array[] = [];
  let raf: number | undefined;
  let onFlushed: (() => void) | undefined;

  function flush(): void {
    if (raf !== undefined) {
      cancelAnimationFrame(raf);
      raf = undefined;
    }
    if (queue.length === 0) return;
    const merged = concatUint8(queue);
    queue = [];
    const cb = onFlushed;
    onFlushed = undefined;
    write(merged, cb);
  }

  return {
    push(chunk, callback) {
      queue.push(chunk);
      if (callback) onFlushed = callback;
      if (raf === undefined) {
        raf = requestAnimationFrame(() => {
          raf = undefined;
          flush();
        });
      }
    },
    flush,
    dispose() {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      queue = [];
      onFlushed = undefined;
    },
  };
}

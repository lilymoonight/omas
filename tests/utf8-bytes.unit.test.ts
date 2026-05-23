import { describe, it, expect } from 'vitest';
import { alignUtf8Start, stripLeadingPartialUtf8 } from '../src/server/pty/utf8-bytes.js';

describe('utf8-bytes', () => {
  it('aligns to the next code point after a mid-character offset', () => {
    const buf = Buffer.from('仔细', 'utf8');
    expect(alignUtf8Start(buf, 1)).toBe(3);
    expect(buf.subarray(alignUtf8Start(buf, 1)).toString('utf8')).toBe('细');
  });

  it('strips orphaned continuation bytes', () => {
    const zi = Buffer.from('仔', 'utf8');
    const tail = stripLeadingPartialUtf8(Buffer.from([zi[1]!, zi[2]!]));
    expect(tail.length).toBe(0);
  });
});

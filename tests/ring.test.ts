import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/server/pty/ring.js';

const b = (s: string) => Buffer.from(s);

describe('RingBuffer', () => {
  it('starts empty', () => {
    const r = new RingBuffer(100);
    expect(r.currentSeq).toBe(0);
    const { bytes, seq, truncated } = r.since(0);
    expect(bytes.length).toBe(0);
    expect(seq).toBe(0);
    expect(truncated).toBe(false);
  });

  it('appends and replays in full', () => {
    const r = new RingBuffer(100);
    r.append(b('hello '));
    r.append(b('world'));
    expect(r.currentSeq).toBe(11);
    const dump = r.since(0);
    expect(dump.bytes.toString()).toBe('hello world');
    expect(dump.truncated).toBe(false);
  });

  it('replays only the tail after a given seq', () => {
    const r = new RingBuffer(100);
    r.append(b('hello '));
    const mid = r.currentSeq;
    r.append(b('world'));
    const dump = r.since(mid);
    expect(dump.bytes.toString()).toBe('world');
    expect(dump.truncated).toBe(false);
  });

  it('returns empty when since == current', () => {
    const r = new RingBuffer(100);
    r.append(b('abc'));
    const dump = r.since(r.currentSeq);
    expect(dump.bytes.length).toBe(0);
  });

  it('trims when capacity is exceeded and marks truncated', () => {
    const r = new RingBuffer(10);
    r.append(b('aaaaa')); // 5
    r.append(b('bbbbb')); // 10
    r.append(b('ccccc')); // 15 — pushes oldest out
    // first chunk dropped, oldest seq becomes 5
    const fromZero = r.since(0);
    expect(fromZero.truncated).toBe(true);
    expect(fromZero.bytes.toString()).toBe('bbbbbccccc');
  });

  it('partial slice from mid-chunk', () => {
    const r = new RingBuffer(100);
    r.append(b('abcdef'));
    const dump = r.since(3);
    expect(dump.bytes.toString()).toBe('def');
  });

  it('does not split UTF-8 code points when slicing since()', () => {
    const r = new RingBuffer(100);
    const text = '美学，仔细review';
    const buf = b(text);
    r.append(buf);
    const ziOff = buf.indexOf(Buffer.from('仔', 'utf8'));
    const dump = r.since(ziOff + 1);
    expect(dump.bytes.toString('utf8')).toBe('细review');
    expect(dump.bytes.toString('utf8')).not.toContain('\uFFFD');
  });

  it('trims on UTF-8 boundaries after eviction', () => {
    const line = '─'.repeat(20); // box-drawing, 3 bytes each
    const r = new RingBuffer(30);
    r.append(b('prefix-'));
    r.append(b(line));
    const dump = r.since(0);
    expect(dump.truncated).toBe(true);
    expect(dump.bytes.toString('utf8')).not.toContain('\uFFFD');
  });

  it('handles many small appends with eviction', () => {
    const r = new RingBuffer(20);
    for (let i = 0; i < 100; i++) r.append(b('x'));
    expect(r.currentSeq).toBe(100);
    const dump = r.since(0);
    expect(dump.truncated).toBe(true);
    // we keep at most ~capacity bytes; never less than the most recent
    expect(dump.bytes.length).toBeGreaterThan(0);
    expect(dump.bytes.length).toBeLessThanOrEqual(20);
  });
});

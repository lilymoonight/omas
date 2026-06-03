import { describe, expect, it } from 'vitest';
import { Osc7CwdParser, parseOsc7Cwd } from '../src/server/pty/osc-cwd.js';

describe('parseOsc7Cwd', () => {
  it('parses file URL with hostname', () => {
    expect(parseOsc7Cwd('7;file://localhost/Users/alice/proj')).toBe('/Users/alice/proj');
  });

  it('parses file URL without hostname segment', () => {
    expect(parseOsc7Cwd('7;file:///tmp/work')).toBe('/tmp/work');
  });

  it('returns null for non-OSC-7 payloads', () => {
    expect(parseOsc7Cwd('0;title')).toBeNull();
    expect(parseOsc7Cwd('')).toBeNull();
  });
});

describe('Osc7CwdParser', () => {
  it('extracts cwd from BEL-terminated OSC 7', () => {
    const paths: string[] = [];
    const parser = new Osc7CwdParser();
    const seq = '\x1b]7;file://localhost/home/u/w\x07';
    parser.feed(Buffer.from(seq), (p) => paths.push(p));
    expect(paths).toEqual(['/home/u/w']);
  });

  it('extracts cwd from ST-terminated OSC 7', () => {
    const paths: string[] = [];
    const parser = new Osc7CwdParser();
    const seq = '\x1b]7;file://host/var/log\x1b\\';
    parser.feed(Buffer.from(seq), (p) => paths.push(p));
    expect(paths).toEqual(['/var/log']);
  });

  it('handles OSC split across chunks', () => {
    const paths: string[] = [];
    const parser = new Osc7CwdParser();
    const seq = '\x1b]7;file://localhost/a/b\x07';
    parser.feed(Buffer.from(seq.slice(0, 8)), (p) => paths.push(p));
    parser.feed(Buffer.from(seq.slice(8)), (p) => paths.push(p));
    expect(paths).toEqual(['/a/b']);
  });
});

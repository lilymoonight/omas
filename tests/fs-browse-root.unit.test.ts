import { describe, expect, it } from 'vitest';
import { isUnderRoot } from '../src/server/pty/fs-util.js';

describe('fsBrowseContext logic', () => {
  it('isUnderRoot matches fs-path semantics', () => {
    expect(isUnderRoot('/sandbox/project', '/sandbox/project/src')).toBe(true);
    expect(isUnderRoot('/sandbox/project', '/sandbox/project')).toBe(true);
    expect(isUnderRoot('/sandbox/project', '/sandbox/other')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { isPathUnder, normalizePath } from '../src/web/lib/fs-path.js';
import { filesBrowseRoot, sandboxBadgeMode } from '../src/web/lib/sandbox-state.js';
import type { Session } from '../src/shared/session.js';

const base: Session = {
  id: 's1',
  title: 't',
  shell: '/bin/zsh',
  cwd: '/sandbox/project',
  cols: 80,
  rows: 24,
  createdAt: '',
  lastActivityAt: '',
  clientCount: 1,
  exited: false,
  sandboxed: true,
};

describe('fs-path', () => {
  it('normalizes trailing slashes', () => {
    expect(normalizePath('/foo/bar/')).toBe('/foo/bar');
  });

  it('detects path under root', () => {
    expect(isPathUnder('/sandbox/project', '/sandbox/project/src')).toBe(true);
    expect(isPathUnder('/sandbox/project', '/sandbox/other')).toBe(false);
  });
});

describe('sandbox-state', () => {
  it('classifies sandbox modes', () => {
    expect(sandboxBadgeMode({ ...base, sandboxed: false })).toBe('off');
    expect(sandboxBadgeMode({ ...base, liveCwd: '/sandbox/project/src' })).toBe('inside');
    expect(sandboxBadgeMode({ ...base, liveCwd: '/Users/alice' })).toBe('outside');
  });

  it('files browse root follows live cwd', () => {
    expect(filesBrowseRoot(base, '/Users/alice')).toBe('/Users/alice');
    expect(filesBrowseRoot(base, '/sandbox/project/lib')).toBe('/sandbox/project/lib');
    expect(filesBrowseRoot({ ...base, sandboxed: false }, '/anywhere')).toBe('/anywhere');
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDefaultCwd } from '../src/server/pty/default-cwd.js';

describe('resolveDefaultCwd', () => {
  it('prefers explicit over env and config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omas-cwd-'));
    expect(resolveDefaultCwd({ explicit: dir, env: '/nope', config: '/nope' })).toBe(path.resolve(dir));
    fs.rmSync(dir, { recursive: true });
  });

  it('falls back to $HOME when path missing', () => {
    expect(resolveDefaultCwd({ explicit: '/nonexistent/omas-test-cwd-xyz' })).toBe(os.homedir());
  });
});

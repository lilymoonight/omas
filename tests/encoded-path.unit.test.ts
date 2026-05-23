import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeEncodedPathNaive,
  resolveEncodedPath,
} from '../src/server/history/encoded-path.js';

describe('encoded-path', () => {
  it('naive decode splits every hyphen', () => {
    expect(decodeEncodedPathNaive('Users-alice-Documents-my-app')).toBe(
      '/Users/alice/Documents/my/app',
    );
  });

  it('resolveEncodedPath keeps hyphenated directory names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omas-enc-'));
    const real = join(root, 'oh-my-agent-shell');
    await mkdir(real, { recursive: true });
    const encoded = real.slice(1).replace(/\//g, '-');
    const resolved = await resolveEncodedPath(encoded);
    expect(resolved).toBe(real);
  });

  it('resolves hyphenated project under a Documents-style tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omas-doc-'));
    const project = join(root, 'Users', 'alice', 'Documents', 'oh-my-agent-shell');
    await mkdir(project, { recursive: true });
    const encoded = project.slice(1).replace(/\//g, '-');
    const resolved = await resolveEncodedPath(encoded);
    expect(resolved).toBe(project);
  });

  it('resolves macOS /var/folders temp paths with _ prefixes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'omas-var-'));
    const base = join(root, 'var', 'folders', '_q', '_abc123', 'T', '10c90327-2af8-4711-8bd1-ba0ed30211b6');
    await mkdir(base, { recursive: true });
    const encoded = base.slice(1).replace(/\//g, '-');
    const resolved = await resolveEncodedPath(encoded);
    expect(resolved).toBe(base);
  });
});

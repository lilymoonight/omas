import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  isValidSlug,
  parsePublishArgs,
  mergeSiteSpecs,
  resolveWithinRoot,
  mimeFor,
} from '../src/server/sites/util.js';

describe('sites/util', () => {
  it('validates slugs', () => {
    expect(isValidSlug('blog')).toBe(true);
    expect(isValidSlug('my-app_2.0')).toBe(true);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('-bad')).toBe(false);
    expect(isValidSlug('has space')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
  });

  it('parses publish args and marks spa', () => {
    const specs = parsePublishArgs(['blog=./site'], ['app=./dist']);
    expect(specs).toEqual([
      { slug: 'blog', root: './site', spa: false },
      { slug: 'app', root: './dist', spa: true },
    ]);
  });

  it('lets the last duplicate slug win', () => {
    const specs = parsePublishArgs(['x=./a', 'x=./b'], []);
    expect(specs).toEqual([{ slug: 'x', root: './b', spa: false }]);
  });

  it('throws on malformed publish args', () => {
    expect(() => parsePublishArgs(['noeq'], [])).toThrow();
    expect(() => parsePublishArgs(['=./d'], [])).toThrow();
    expect(() => parsePublishArgs(['bad slug=./d'], [])).toThrow();
    expect(() => parsePublishArgs(['ok='], [])).toThrow();
  });

  it('merges config + cli specs with cli winning', () => {
    const merged = mergeSiteSpecs(
      [{ slug: 'a', root: '/c/a', spa: false }, { slug: 'b', root: '/c/b', spa: true }],
      [{ slug: 'a', root: '/cli/a', spa: true }],
    );
    expect(merged).toEqual([
      { slug: 'a', root: '/cli/a', spa: true },
      { slug: 'b', root: '/c/b', spa: true },
    ]);
  });

  it('resolves paths within root and blocks traversal', () => {
    const root = '/srv/site';
    expect(resolveWithinRoot(root, 'index.html')).toBe(path.join(root, 'index.html'));
    expect(resolveWithinRoot(root, 'assets/app.js')).toBe(path.join(root, 'assets/app.js'));
    expect(resolveWithinRoot(root, '')).toBe(path.resolve(root));
    expect(resolveWithinRoot(root, '../secret')).toBeNull();
    expect(resolveWithinRoot(root, '../../etc/passwd')).toBeNull();
    expect(resolveWithinRoot(root, 'a/../../b')).toBeNull();
    expect(resolveWithinRoot(root, 'x\0y')).toBeNull();
  });

  it('does not let a sibling prefix escape the root', () => {
    expect(resolveWithinRoot('/srv/site', '../site-evil/x')).toBeNull();
  });

  it('maps common web mime types', () => {
    expect(mimeFor('a.html')).toContain('text/html');
    expect(mimeFor('a.js')).toContain('javascript');
    expect(mimeFor('a.css')).toContain('text/css');
    expect(mimeFor('a.svg')).toBe('image/svg+xml');
    expect(mimeFor('a.unknownext')).toBe('application/octet-stream');
  });
});

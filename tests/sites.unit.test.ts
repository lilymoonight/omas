import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  isValidSlug,
  parsePublishArgs,
  mergeSiteSpecs,
  resolveWithinRoot,
  mimeFor,
} from '../src/server/sites/util.js';
import {
  buildBreadcrumbs,
  groupEntriesByDate,
  newestMtime,
  renderDirListingHtml,
  type DirEntry,
} from '../src/server/sites/dir-listing.js';

describe('sites/util', () => {
  it('validates slugs', () => {
    expect(isValidSlug('blog')).toBe(true);
    expect(isValidSlug('my-app_2.0')).toBe(true);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('-bad')).toBe(false);
    expect(isValidSlug('has space')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
  });

  it('parses publish args', () => {
    const specs = parsePublishArgs(['blog=./site', 'app=./dist']);
    expect(specs).toEqual([
      { slug: 'blog', root: './site' },
      { slug: 'app', root: './dist' },
    ]);
  });

  it('lets the last duplicate slug win', () => {
    const specs = parsePublishArgs(['x=./a', 'x=./b']);
    expect(specs).toEqual([{ slug: 'x', root: './b' }]);
  });

  it('throws on malformed publish args', () => {
    expect(() => parsePublishArgs(['noeq'])).toThrow();
    expect(() => parsePublishArgs(['=./d'])).toThrow();
    expect(() => parsePublishArgs(['bad slug=./d'])).toThrow();
    expect(() => parsePublishArgs(['ok='])).toThrow();
  });

  it('merges config + cli specs with cli winning', () => {
    const merged = mergeSiteSpecs(
      [{ slug: 'a', root: '/c/a' }, { slug: 'b', root: '/c/b' }],
      [{ slug: 'a', root: '/cli/a' }],
    );
    expect(merged).toEqual([
      { slug: 'a', root: '/cli/a' },
      { slug: 'b', root: '/c/b' },
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

describe('sites/dir-listing', () => {
  it('builds breadcrumbs from the public URL path', () => {
    const root = '/p/blog/';
    expect(buildBreadcrumbs('/p/blog/', root)).toEqual([{ label: '根目录', href: null }]);
    expect(buildBreadcrumbs('/p/blog/docs/', root)).toEqual([
      { label: '根目录', href: root },
      { label: 'docs', href: null },
    ]);
    expect(buildBreadcrumbs('/p/blog/docs/api/', root)).toEqual([
      { label: '根目录', href: root },
      { label: 'docs', href: '/p/blog/docs/' },
      { label: 'api', href: null },
    ]);
  });

  it('marks only the newest date group with NEW', () => {
    const entries: DirEntry[] = [
      { name: 'old.md', isDir: false, size: 10, mtimeMs: 1000 },
      { name: 'new.md', isDir: false, size: 20, mtimeMs: 2000 },
      { name: 'also-new.txt', isDir: false, size: 5, mtimeMs: 2000 },
    ];
    expect(newestMtime(entries)).toBe(2000);
    const html = renderDirListingHtml('/p/s/', '/p/s/', entries, false);
    expect(html).toContain('date-head');
    expect(html.match(/NEW/g)?.length).toBe(1);
    expect(html).not.toMatch(/new\.md[\s\S]*?NEW/);
    expect(html).not.toMatch(/also-new\.txt[\s\S]*?NEW/);
  });

  it('groups entries by date with newest sections first', () => {
    const entries: DirEntry[] = [
      { name: 'a.txt', isDir: false, size: 1, mtimeMs: Date.parse('2026-06-18') },
      { name: 'b.txt', isDir: false, size: 2, mtimeMs: Date.parse('2026-06-20') },
      { name: 'c.txt', isDir: false, size: 3, mtimeMs: Date.parse('2026-06-20T12:00:00') },
    ];
    const groups = groupEntriesByDate(entries);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries.map((e) => e.name).sort()).toEqual(['b.txt', 'c.txt']);
    expect(groups[1]!.entries.map((e) => e.name)).toEqual(['a.txt']);

    const html = renderDirListingHtml('/p/s/', '/p/s/', entries, false);
    expect(html).toContain('date-group');
    expect(html.indexOf('2026/06/20')).toBeLessThan(html.indexOf('2026/06/18'));
  });

  it('renders breadcrumb nav and modification dates', () => {
    const html = renderDirListingHtml(
      '/p/site/reports/',
      '/p/site/',
      [{ name: 'q1.html', isDir: false, size: 4096, mtimeMs: Date.parse('2026-06-20') }],
      true,
    );
    expect(html).toContain('breadcrumb');
    expect(html).toContain('根目录');
    expect(html).toContain('reports');
    expect(html).toContain('2026/06/20');
    expect(html).toContain('href="../"');
  });
});

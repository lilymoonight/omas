import { describe, it, expect } from 'vitest';
import { folderBasename, formatTabTitle } from '../src/web/lib/page-title.js';

describe('page-title', () => {
  it('folderBasename takes the last segment', () => {
    expect(folderBasename('/srv/agent/job1')).toBe('job1');
    expect(folderBasename('/Users/alice/projects/my-app/')).toBe('my-app');
    expect(folderBasename('/')).toBeUndefined();
    expect(folderBasename(undefined)).toBeUndefined();
  });

  it('formatTabTitle joins host, folder, and page', () => {
    expect(formatTabTitle({ folder: 'my-app' })).toMatch(/^[^·]+ · my-app$/);
    expect(formatTabTitle({ page: '会话' })).toMatch(/^[^·]+ · 会话$/);
    expect(formatTabTitle({ folder: 'job1', page: '共享' })).toMatch(/^[^·]+ · job1 · 共享$/);
  });
});

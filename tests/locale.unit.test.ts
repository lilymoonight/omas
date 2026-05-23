import { describe, it, expect, afterEach } from 'vitest';
import { resolveUtf8Locale, ptyLocaleEnv } from '../src/server/pty/locale.js';

describe('resolveUtf8Locale', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('prefers an existing UTF-8 LANG', () => {
    process.env.LANG = 'zh_CN.UTF-8';
    delete process.env.LC_ALL;
    expect(resolveUtf8Locale()).toBe('zh_CN.UTF-8');
  });

  it('falls back when no UTF-8 locale is set', () => {
    delete process.env.LANG;
    delete process.env.LC_ALL;
    delete process.env.LC_CTYPE;
    expect(resolveUtf8Locale()).toMatch(/UTF-8|utf8/);
  });

  it('fills LANG/LC_CTYPE only when unset', () => {
    delete process.env.LANG;
    delete process.env.LC_CTYPE;
    const env = ptyLocaleEnv();
    expect(env.LANG).toMatch(/UTF-8|utf8/);
    expect(env.LC_CTYPE).toMatch(/UTF-8|utf8/);

    process.env.LANG = 'ja_JP.UTF-8';
    expect(ptyLocaleEnv()).toEqual({ LC_CTYPE: 'ja_JP.UTF-8' });

    process.env.LC_CTYPE = 'ja_JP.UTF-8';
    expect(ptyLocaleEnv()).toEqual({});
  });
});

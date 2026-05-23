/** Pick a UTF-8 locale for PTY shells when the parent lacks one (launchd/systemd
 *  services often inherit PATH only, so shells default to C and `ls` shows `?`). */
export function resolveUtf8Locale(): string {
  for (const key of ['LC_ALL', 'LANG', 'LC_CTYPE'] as const) {
    const value = process.env[key];
    if (value && /UTF-8|utf8/i.test(value)) return value;
  }
  if (process.platform === 'darwin') return 'en_US.UTF-8';
  return 'C.UTF-8';
}

/** LANG / LC_CTYPE overrides for child shells — only fills in when unset. */
export function ptyLocaleEnv(): Record<string, string> {
  const locale = resolveUtf8Locale();
  const env: Record<string, string> = {};
  if (!process.env.LANG) env.LANG = locale;
  if (!process.env.LC_CTYPE) env.LC_CTYPE = locale;
  return env;
}

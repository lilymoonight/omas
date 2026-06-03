/** Parse OSC 7 (`file://…`) cwd reports from a PTY byte stream (may span frames). */
export class Osc7CwdParser {
  private state: 'normal' | 'esc' | 'osc' | 'osc_st' = 'normal';
  private payload = '';

  feed(buf: Buffer, onCwd: (path: string) => void): void {
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i]!;
      switch (this.state) {
        case 'normal':
          if (c === 0x1b) this.state = 'esc';
          break;
        case 'esc':
          if (c === 0x5d) {
            this.state = 'osc';
            this.payload = '';
          } else {
            this.state = 'normal';
          }
          break;
        case 'osc':
          if (c === 0x07) {
            this.finish(onCwd);
          } else if (c === 0x1b) {
            this.state = 'osc_st';
          } else {
            this.payload += String.fromCharCode(c);
          }
          break;
        case 'osc_st':
          if (c === 0x5c) {
            this.finish(onCwd);
          } else {
            this.payload += `\x1b${String.fromCharCode(c)}`;
            this.state = 'osc';
          }
          break;
      }
    }
  }

  private finish(onCwd: (path: string) => void): void {
    const path = parseOsc7Cwd(this.payload);
    if (path) onCwd(path);
    this.state = 'normal';
    this.payload = '';
  }
}

/** Extract a filesystem path from an OSC 7 payload (`7;file://host/path`). */
export function parseOsc7Cwd(payload: string): string | null {
  if (!payload.startsWith('7')) return null;
  const rest = payload.startsWith('7;') ? payload.slice(2) : payload.slice(1);
  if (!rest.startsWith('file://')) return null;
  try {
    const u = new URL(rest);
    if (u.protocol !== 'file:') return null;
    const p = decodeURIComponent(u.pathname);
    return p || null;
  } catch {
    const m = rest.match(/^file:\/\/[^/]*(\/.+)$/);
    return m?.[1] ? decodeURIComponent(m[1]) : null;
  }
}

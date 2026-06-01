// `omas connect <url>` — a terminal-native client (no browser) that bridges the
// local TTY to a remote omas session, behaving like `ssh`. It reuses the exact
// HTTP + WebSocket stack the web UI uses: password login → cookie, create (or
// attach) a session, then pipe stdin↔output over the same /attach socket. So it
// works through whatever TLS reverse proxy already fronts the domain — no extra
// port, no separate protocol.
//
// Detach without killing the shell: press Ctrl-] (the session keeps running on
// the host; reconnect any time). Typing `exit` ends the shell as usual.

import { WebSocket } from 'ws';
import type { ClientMessage } from '../../shared/protocol.js';

export type ConnectOpts = {
  url: string;
  session?: string;
  list?: boolean;
  shell?: string;
  cwd?: string;
  password?: string;
  insecure?: boolean;
};

export type Base = { http: string; ws: string; label: string };

/** Normalize a user-supplied target into http(s) + ws(s) bases.
 *  Accepts `domain`, `https://domain`, `http://host:7681`, `https://domain/prefix`. */
export function normalizeBase(input: string): Base {
  const withScheme = /:\/\//.test(input) ? input : `https://${input}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`无法解析地址：${input}`);
  }
  // Preserve any reverse-proxy path prefix, drop a trailing slash.
  const prefix = u.pathname.replace(/\/+$/, '');
  const http = `${u.protocol}//${u.host}${prefix}`;
  const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = `${wsProto}//${u.host}${prefix}`;
  return { http, ws, label: u.host };
}

function termSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  };
}

/** Read a password from the TTY without echoing it. */
function promptPassword(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('没有可交互的终端来输入密码；请用 --password 或设置 OMAS_PASSWORD'));
      return;
    }
    process.stdout.write(prompt);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (d: Buffer): void => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(buf);
          return;
        }
        if (ch === '\u0003') {
          // Ctrl-C
          cleanup();
          process.stdout.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          buf = buf.slice(0, -1);
        } else if (ch >= ' ') {
          buf += ch;
        }
      }
    };
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

/** Pull the omas_sid cookie out of a login response's Set-Cookie header(s). */
function readSessionCookie(headers: Headers): string {
  const getter = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  const raw = getter ? getter.call(headers) : [headers.get('set-cookie') ?? ''];
  for (const c of raw) {
    const first = c.split(';', 1)[0]?.trim() ?? '';
    if (first.startsWith('omas_sid=')) return first;
  }
  return '';
}

export function authHeaders(cookie: string, json = false): Record<string, string> {
  const h: Record<string, string> = {};
  if (cookie) h.Cookie = cookie;
  if (json) h['content-type'] = 'application/json';
  return h;
}

export async function authenticate(base: Base, opts: { password?: string }): Promise<string> {
  const meRes = await fetch(`${base.http}/api/auth/me`);
  if (!meRes.ok) throw new Error(`无法连接到 ${base.label}（HTTP ${meRes.status}）`);
  const me = (await meRes.json()) as { authRequired?: boolean };
  if (!me.authRequired) return '';

  let password = opts.password ?? process.env.OMAS_PASSWORD ?? '';
  if (!password) password = await promptPassword(`omas 密码（${base.label}）: `);

  const res = await fetch(`${base.http}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (res.status === 429) throw new Error('登录被限流，请稍后再试');
  if (!res.ok) throw new Error('密码错误');
  const cookie = readSessionCookie(res.headers);
  if (!cookie) throw new Error('登录成功但服务器未返回会话 cookie');
  return cookie;
}

async function listSessions(base: Base, cookie: string): Promise<void> {
  const res = await fetch(`${base.http}/api/sessions`, { headers: authHeaders(cookie) });
  if (!res.ok) throw new Error(`获取会话列表失败（HTTP ${res.status}）`);
  const list = (await res.json()) as Array<{ id: string; title: string; liveCwd?: string | null; cwd?: string | null }>;
  if (list.length === 0) {
    process.stdout.write('（暂无会话）\n');
    return;
  }
  for (const s of list) {
    const cwd = s.liveCwd ?? s.cwd ?? '';
    process.stdout.write(`${s.id}\t${s.title}\t${cwd}\n`);
  }
}

async function createSession(base: Base, cookie: string, opts: ConnectOpts): Promise<string> {
  const { cols, rows } = termSize();
  const body: Record<string, unknown> = { cols, rows };
  if (opts.shell) body.shell = opts.shell;
  if (opts.cwd) body.cwd = opts.cwd;
  const res = await fetch(`${base.http}/api/sessions`, {
    method: 'POST',
    headers: authHeaders(cookie, true),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`创建会话失败（HTTP ${res.status}）`);
  const s = (await res.json()) as { id: string };
  return s.id;
}

type ExitInfo = { code: number | null; signal: string | null };

/** Bridge the local TTY to the session's /attach WebSocket until it closes. */
function attach(base: Base, sessionId: string, cookie: string, insecure: boolean): Promise<ExitInfo | null> {
  return new Promise((resolve, reject) => {
    const url = `${base.ws}/api/sessions/${encodeURIComponent(sessionId)}/attach`;
    const ws = new WebSocket(url, {
      headers: authHeaders(cookie),
      rejectUnauthorized: !insecure,
      perMessageDeflate: false,
    });

    const stdin = process.stdin;
    const stdout = process.stdout;
    const isTty = Boolean(stdin.isTTY);
    let raw = false;
    let exitInfo: ExitInfo | null = null;
    let settled = false;

    const send = (msg: ClientMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const sendResize = (): void => {
      const { cols, rows } = termSize();
      send({ type: 'resize', cols, rows });
    };

    const onStdin = (d: Buffer): void => {
      // Ctrl-] (0x1d) on its own = detach (leave the session running).
      if (d.length === 1 && d[0] === 0x1d) {
        ws.close(1000, 'detach');
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(d); // raw bytes → PTY input
    };
    const onWinch = (): void => sendResize();

    const enterRaw = (): void => {
      if (isTty && !raw) {
        stdin.setRawMode(true);
        raw = true;
      }
      stdin.resume();
      stdin.on('data', onStdin);
      process.on('SIGWINCH', onWinch);
    };
    const cleanup = (): void => {
      stdin.off('data', onStdin);
      process.off('SIGWINCH', onWinch);
      if (raw) {
        stdin.setRawMode(false);
        raw = false;
      }
      stdin.pause();
    };

    ws.on('open', () => {
      enterRaw();
      sendResize();
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        stdout.write(data);
        return;
      }
      let msg: { type?: string; t?: number; title?: string; code?: number | null; signal?: string | null };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      switch (msg.type) {
        case 'ping':
          send({ type: 'pong', t: msg.t ?? Date.now() });
          break;
        case 'title':
          if (isTty && msg.title) stdout.write(`\x1b]0;${msg.title}\x07`);
          break;
        case 'exit':
          exitInfo = { code: msg.code ?? null, signal: msg.signal ?? null };
          ws.close(1000, 'session_exited');
          break;
        // hello / ack / clients: nothing to do for a raw terminal client.
      }
    });

    ws.on('close', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exitInfo);
    });
    ws.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}

export async function runConnect(opts: ConnectOpts): Promise<void> {
  const base = normalizeBase(opts.url);
  if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const cookie = await authenticate(base, opts);

  if (opts.list) {
    await listSessions(base, cookie);
    return;
  }

  const sessionId = opts.session ?? (await createSession(base, cookie, opts));

  if (process.stdin.isTTY) {
    process.stdout.write(`已连接 ${base.label}（会话 ${sessionId}）。Ctrl-] 断开，exit 结束 shell。\r\n`);
  }
  const exitInfo = await attach(base, sessionId, cookie, opts.insecure ?? false);

  if (exitInfo) {
    if (process.stdin.isTTY) process.stdout.write(`\r\nshell 已退出（${exitInfo.code ?? exitInfo.signal ?? 0}）\r\n`);
    process.exit(exitInfo.code ?? (exitInfo.signal ? 1 : 0));
  } else {
    if (process.stdin.isTTY) process.stdout.write(`\r\n已断开（会话 ${sessionId} 仍在后台运行）\r\n`);
    process.exit(0);
  }
}

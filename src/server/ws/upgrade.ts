import type { IncomingMessage } from 'node:http';
import { type Socket } from 'node:net';
import { WebSocketServer } from 'ws';
import type { SessionHub } from '../pty/hub.js';
import { attachClient } from './attach.js';
import { logger } from '../logger.js';

const SESSION_RE = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/attach(?:\?(.*))?$/;

type UpgradeAuthCheck = (req: IncomingMessage) => boolean;

export function installWsUpgrade(
  rawServer: { on: (event: 'upgrade', cb: (req: IncomingMessage, socket: Socket, head: Buffer) => void) => unknown },
  hub: SessionHub,
  isAuthed: UpgradeAuthCheck = () => true,
): void {
  const wss = new WebSocketServer({ noServer: true });

  rawServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    const match = SESSION_RE.exec(url);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const sessionId = match[1]!;
    const queryString = match[2] ?? '';
    if (!isAuthed(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    // Origin check: reject cross-origin upgrades. Permit no-Origin (curl, native clients).
    const origin = req.headers.origin;
    if (origin) {
      try {
        const expectedHost = req.headers.host;
        const o = new URL(origin);
        if (expectedHost && o.host !== expectedHost) {
          logger.warn({ origin, expectedHost }, 'rejecting ws upgrade: origin mismatch');
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    const session = hub.get(sessionId);
    if (!session) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const since = parseSince(queryString);
    wss.handleUpgrade(req, socket, head, (ws) => attachClient(ws, session, since));
  });
}

function parseSince(qs: string): number {
  if (!qs) return 0;
  for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=');
    if (k === 'since' && v != null) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return 0;
}

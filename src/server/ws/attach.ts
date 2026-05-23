import { WebSocket, type RawData } from 'ws';
import type { PtySession } from '../pty/session.js';
import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';
import { logger } from '../logger.js';

const ACK_INTERVAL_MS = 2000;
const ACK_BYTE_THRESHOLD = 64 * 1024;
const PING_INTERVAL_MS = 20000;
const PONG_TIMEOUT_MS = 10000;

function sendJson(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(msg));
}

export function attachClient(ws: WebSocket, session: PtySession, since: number): void {
  const clientTag = session.attachClient();
  let lastAckSeq = 0;
  let bytesSinceAck = 0;
  let awaitingPongSince: number | null = null;
  let closed = false;

  // Two attach paths:
  //   - Live reconnect (since > 0, ring still has the delta) → replay the
  //     exact byte delta. Cheap, preserves animations, and the client's
  //     xterm already holds the prior state.
  //   - Fresh attach or ring stale (since == 0, or `truncated` from ring) →
  //     serialize the headless mirror's current screen + scrollback into a
  //     blob of ANSI escapes. Replaying that into a clean xterm.js produces
  //     the live screen pixel-for-pixel, even for TUI apps whose own clear
  //     escapes are baked into the raw stream.
  let initialBytes: Buffer;
  let truncated: boolean;
  if (since > 0) {
    const dump = session.ring.since(since);
    if (!dump.truncated) {
      initialBytes = dump.bytes;
      truncated = false;
      lastAckSeq = dump.seq;
    } else {
      const snap = session.serializeSnapshot();
      initialBytes = snap.bytes;
      truncated = true;
      lastAckSeq = session.ring.currentSeq;
    }
  } else {
    const snap = session.serializeSnapshot();
    initialBytes = snap.bytes;
    truncated = true;
    lastAckSeq = session.ring.currentSeq;
  }
  sendJson(ws, {
    type: 'hello',
    seq: lastAckSeq,
    cols: session.cols,
    rows: session.rows,
    truncated,
    clientCount: session.clients.size,
  });
  if (initialBytes.length > 0) ws.send(initialBytes);

  const onData = (buf: Buffer): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(buf);
    bytesSinceAck += buf.length;
    if (bytesSinceAck >= ACK_BYTE_THRESHOLD) {
      lastAckSeq = session.ring.currentSeq;
      bytesSinceAck = 0;
      sendJson(ws, { type: 'ack', seq: lastAckSeq });
    }
  };
  const onExit = (info: { code: number | null; signal: string | null }): void => {
    sendJson(ws, { type: 'exit', code: info.code, signal: info.signal });
    ws.close(1000, 'session_exited');
  };
  const onTitle = (title: string): void => sendJson(ws, { type: 'title', title });
  const onClients = (count: number): void => sendJson(ws, { type: 'clients', count });

  session.on('data', onData);
  session.on('exit', onExit);
  session.on('title', onTitle);
  session.on('clients', onClients);

  const ackTimer = setInterval(() => {
    const cur = session.ring.currentSeq;
    if (cur !== lastAckSeq) {
      lastAckSeq = cur;
      bytesSinceAck = 0;
      sendJson(ws, { type: 'ack', seq: cur });
    }
  }, ACK_INTERVAL_MS);

  const pingTimer = setInterval(() => {
    if (awaitingPongSince !== null && Date.now() - awaitingPongSince > PONG_TIMEOUT_MS) {
      logger.warn({ id: session.id }, 'pong timeout — closing ws');
      ws.terminate();
      return;
    }
    awaitingPongSince = Date.now();
    sendJson(ws, { type: 'ping', t: awaitingPongSince });
  }, PING_INTERVAL_MS);

  ws.on('message', (raw: RawData, isBinary: boolean) => {
    if (isBinary) {
      // Raw bytes from client (e.g. paste of arbitrary binary).
      const buf = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer);
      session.write(buf);
      return;
    }
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'input':
        session.write(msg.data);
        break;
      case 'resize':
        session.resize(msg.cols, msg.rows);
        break;
      case 'title':
        session.setTitle(msg.title);
        break;
      case 'pong':
        awaitingPongSince = null;
        break;
    }
  });

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(ackTimer);
    clearInterval(pingTimer);
    session.off('data', onData);
    session.off('exit', onExit);
    session.off('title', onTitle);
    session.off('clients', onClients);
    session.detachClient(clientTag);
  };

  ws.on('close', cleanup);
  ws.on('error', (err) => {
    logger.warn({ err, id: session.id }, 'ws error');
    cleanup();
  });
}

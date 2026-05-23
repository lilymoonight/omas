import type { ClientMessage, ServerMessage } from '../../shared/protocol.js';
import { wsUrl } from './api.js';

export type WsEvents = {
  hello: (msg: Extract<ServerMessage, { type: 'hello' }>) => void;
  data: (bytes: Uint8Array) => void;
  exit: (info: { code: number | null; signal: string | null }) => void;
  title: (title: string) => void;
  clients: (count: number) => void;
  status: (status: 'connecting' | 'open' | 'closed') => void;
};

const BACKOFF_MS = [250, 500, 1000, 2000, 5000] as const;

export class SessionSocket {
  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private retry = 0;
  private closed = false;
  private listeners: { [K in keyof WsEvents]: Set<WsEvents[K]> } = {
    hello: new Set(),
    data: new Set(),
    exit: new Set(),
    title: new Set(),
    clients: new Set(),
    status: new Set(),
  };

  // lastSeq lives only for the lifetime of this SessionSocket. A new XTerm
  // mount means a blank screen, which means we want the server to dump the
  // full scrollback again — don't persist seq across mounts or refreshes.
  constructor(private readonly sessionId: string) {}

  on<K extends keyof WsEvents>(event: K, handler: WsEvents[K]): () => void {
    this.listeners[event].add(handler);
    return () => this.listeners[event].delete(handler);
  }

  private emit<K extends keyof WsEvents>(event: K, ...args: Parameters<WsEvents[K]>): void {
    for (const h of this.listeners[event]) {
      // @ts-expect-error variadic on union
      h(...args);
    }
  }

  connect(): void {
    if (this.closed) return;
    this.emit('status', 'connecting');
    const url = wsUrl(`sessions/${this.sessionId}/attach?since=${this.lastSeq}`);
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.emit('status', 'open');
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'hello':
            this.lastSeq = msg.seq;
            this.emit('hello', msg);
            break;
          case 'ack':
            this.lastSeq = msg.seq;
            break;
          case 'title':
            this.emit('title', msg.title);
            break;
          case 'clients':
            this.emit('clients', msg.count);
            break;
          case 'exit':
            this.emit('exit', { code: msg.code, signal: msg.signal });
            // server will close — let onclose drive reconnect (it won't, we'll mark closed)
            this.closed = true;
            break;
          case 'ping':
            this.send({ type: 'pong', t: msg.t });
            break;
        }
      } else {
        const buf = new Uint8Array(ev.data as ArrayBuffer);
        // server doesn't tag binary frames with seq; the next ack will catch us up
        this.emit('data', buf);
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.emit('status', 'closed');
      if (!this.closed) this.scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* */
      }
    };
  }

  private scheduleReconnect(): void {
    const delay = BACKOFF_MS[Math.min(this.retry, BACKOFF_MS.length - 1)]!;
    this.retry++;
    setTimeout(() => this.connect(), delay);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(bytes);
  }

  close(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* */
      }
      this.ws = null;
    }
  }

}

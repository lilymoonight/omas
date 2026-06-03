// Wire protocol between server and browser. Text frames are JSON ClientMessage/ServerMessage;
// binary frames are raw PTY bytes (server→client = PTY output, client→server = paste-style input).

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'pong'; t: number }
  | { type: 'title'; title: string };

export type ServerMessage =
  | { type: 'hello'; seq: number; cols: number; rows: number; truncated: boolean; clientCount: number; cwd?: string }
  | { type: 'ack'; seq: number }
  | { type: 'title'; title: string }
  | { type: 'cwd'; path: string }
  | { type: 'clients'; count: number }
  | { type: 'exit'; code: number | null; signal: string | null }
  | { type: 'ping'; t: number };

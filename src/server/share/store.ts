import { nanoid } from 'nanoid';

/**
 * In-memory registry of read-only share tokens. A token grants view-only access
 * to one session's live output over WebSocket (no input, no resize). Tokens are
 * deliberately ephemeral — they live only for the process lifetime, so a restart
 * invalidates every outstanding link. Each session has at most one active token;
 * re-sharing returns the existing one so links stay stable.
 */
export class ShareStore {
  private tokenToSession = new Map<string, string>();
  private sessionToToken = new Map<string, string>();

  /** Create (or return the existing) share token for a session. */
  create(sessionId: string): string {
    const existing = this.sessionToToken.get(sessionId);
    if (existing) return existing;
    const token = nanoid(24);
    this.tokenToSession.set(token, sessionId);
    this.sessionToToken.set(sessionId, token);
    return token;
  }

  /** The active token for a session, if any. */
  tokenFor(sessionId: string): string | null {
    return this.sessionToToken.get(sessionId) ?? null;
  }

  /** Resolve a token back to its session id, if the token is live. */
  sessionFor(token: string): string | null {
    return this.tokenToSession.get(token) ?? null;
  }

  /** Revoke a session's token (best-effort; no-op if none). */
  revoke(sessionId: string): void {
    const token = this.sessionToToken.get(sessionId);
    if (token) this.tokenToSession.delete(token);
    this.sessionToToken.delete(sessionId);
  }
}

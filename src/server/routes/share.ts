import type { SessionHub } from '../pty/hub.js';
import type { ShareStore } from '../share/store.js';

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  post: (path: string, handler: (req: any, reply: any) => any) => unknown;
  delete: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

export function registerShareRoutes(app: App, hub: SessionHub, shares: ShareStore): void {
  // Mint (or fetch) a read-only share token for a session. Authed via the global
  // guard (it lives under /api/sessions/*).
  app.post('/api/sessions/:id/share', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    const token = shares.create(session.id);
    return { ok: true, token };
  });

  app.get('/api/sessions/:id/share', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    return { token: shares.tokenFor(session.id) };
  });

  app.delete('/api/sessions/:id/share', async (req: any, reply: any) => {
    const session = hub.get(req.params.id);
    if (!session) return reply.code(404).send({ error: 'session_not_found' });
    shares.revoke(session.id);
    return { ok: true };
  });

  // Public, no-auth metadata for a shared viewer (whitelisted in the auth guard).
  // Reveals only what the viewer needs to render — never the session id.
  app.get('/api/shared/:token', async (req: any, reply: any) => {
    const sessionId = shares.sessionFor(req.params.token);
    const session = sessionId ? hub.get(sessionId) : null;
    if (!session) return reply.code(404).send({ error: 'not_found' });
    const json = session.toJSON();
    return { ok: true, title: json.title, cols: json.cols, rows: json.rows };
  });
}

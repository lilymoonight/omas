import { z } from 'zod';
import { type SessionHub, HubError } from '../pty/hub.js';
import { foregroundForPids } from '../pty/foreground.js';
import { shellCwd } from '../pty/shell-cwd.js';
// Loose Fastify shape so we don't fight generics with whatever loggerInstance the caller used.
type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
  post: (path: string, handler: (req: any, reply: any) => any) => unknown;
  patch: (path: string, handler: (req: any, reply: any) => any) => unknown;
  delete: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

const createSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  shell: z.string().min(1).max(200).optional(),
  cwd: z.string().min(1).max(1024).optional(),
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(500),
  initialCommand: z.string().min(1).max(2048).optional(),
});

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
});

const inputSchema = z.object({
  data: z.string().max(8192),
});

function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

function safeLabel(label: string): string {
  const cleaned = label.trim().replace(/[\/\\:*?"<>|\x00-\x1f]+/g, '').replace(/\s+/g, '-').slice(0, 60);
  return cleaned || 'session';
}

function contentDisposition(name: string): string {
  const ascii = name.replace(/["\\\r\n]/g, '_').replace(/[^\x20-\x7e]/g, '_') || 'download';
  const enc = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${enc}`;
}

export function registerSessionRoutes(app: App, hub: SessionHub): void {
  app.get('/api/sessions', async () => {
    const list = hub.list();
    const [fg, cwds] = await Promise.all([
      foregroundForPids(list.map((s) => s.pid)),
      Promise.all(list.map((s) => shellCwd(s.pid))),
    ]);
    return list.map((s, i) => {
      const info = s.pid != null ? fg.get(s.pid) : undefined;
      return {
        ...s.toJSON(),
        foreground: info?.foreground ?? null,
        agent: info?.agent ?? null,
        agentState: info?.agentState ?? null,
        liveCwd: cwds[i] ?? null,
      };
    });
  });

  app.post('/api/sessions', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    try {
      const s = hub.create(parsed.data);
      return reply.code(201).send(s.toJSON());
    } catch (err) {
      if (err instanceof HubError) return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = hub.get(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const [fg, liveCwd] = await Promise.all([foregroundForPids([s.pid]), shellCwd(s.pid)]);
    const info = s.pid != null ? fg.get(s.pid) : undefined;
    return {
      ...s.toJSON(),
      foreground: info?.foreground ?? null,
      agent: info?.agent ?? null,
      agentState: info?.agentState ?? null,
      liveCwd: liveCwd ?? null,
    };
  });

  app.post('/api/sessions/:id/input', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = hub.get(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    s.write(parsed.data.data);
    return { ok: true };
  });

  app.patch('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = hub.get(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    if (parsed.data.title) s.setTitle(parsed.data.title);
    return s.toJSON();
  });

  app.delete('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!hub.destroy(id)) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // Export the full terminal contents (screen + scrollback) from the headless
  // mirror, so it captures history rather than only the client's current screen.
  app.get('/api/sessions/:id/export', async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const s = hub.get(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const format = req.query?.format === 'html' ? 'html' : 'txt';
    const name = `${safeLabel(s.title)}_${fileStamp()}.${format}`;
    reply.header('content-disposition', contentDisposition(name));
    reply.header('cache-control', 'no-store');
    if (format === 'html') {
      reply.header('content-type', 'text/html; charset=utf-8');
      return reply.send(s.serializeHtml());
    }
    reply.header('content-type', 'text/plain; charset=utf-8');
    return reply.send(s.serializeText());
  });
}

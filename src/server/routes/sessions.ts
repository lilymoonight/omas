import { z } from 'zod';
import { type SessionHub, HubError } from '../pty/hub.js';
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

export function registerSessionRoutes(app: App, hub: SessionHub): void {
  app.get('/api/sessions', async () => hub.list().map((s) => s.toJSON()));

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
    return s.toJSON();
  });

  app.post('/api/sessions/:id/input', async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = hub.get(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    s.write(parsed.data);
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
}

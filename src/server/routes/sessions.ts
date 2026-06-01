import { z } from 'zod';
import { type SessionHub, HubError } from '../pty/hub.js';
import { foregroundForPids } from '../pty/foreground.js';
import { shellCwd, shellCwdMany } from '../pty/shell-cwd.js';
import { resolveSandboxDir, type SandboxSettings } from '../pty/sandbox.js';
import { verifyPassword } from '../auth/password.js';
import type { LoginLimiter } from '../auth/limiter.js';
import type { Config } from '../config.js';
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
  /** Explicit sandbox on/off. Omitted → server's default policy. */
  sandbox: z.boolean().optional(),
  /** Bypass password, required only to create an unsandboxed session. */
  bypass: z.string().max(200).optional(),
});

export type SessionRouteOpts = {
  /** Active sandbox policy, or null when sandboxing isn't configured. */
  sandbox?: SandboxSettings | null;
  /** Loaded config (for the unsandboxed-bypass hash). */
  config?: Config | null;
  /** Reused per-IP limiter to throttle bypass-password guesses. */
  limiter?: LoginLimiter;
};

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
});

const inputSchema = z.object({
  data: z.string().max(8192),
});

const execSchema = z.object({
  command: z.string().min(1).max(1024 * 1024),
  timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
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

export function registerSessionRoutes(app: App, hub: SessionHub, opts: SessionRouteOpts = {}): void {
  const sandboxCfg = opts.sandbox ?? null;
  app.get('/api/sessions', async () => {
    const list = hub.list();
    const pids = list.map((s) => s.pid);
    const [fg, cwds] = await Promise.all([
      foregroundForPids(pids),
      shellCwdMany(pids),
    ]);
    return list.map((s) => {
      const info = s.pid != null ? fg.get(s.pid) : undefined;
      return {
        ...s.toJSON(),
        foreground: info?.foreground ?? null,
        agent: info?.agent ?? null,
        agentState: info?.agentState ?? null,
        liveCwd: s.pid != null ? cwds.get(s.pid) ?? null : null,
      };
    });
  });

  app.post('/api/sessions', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const { sandbox: wantSandboxRaw, bypass, ...createInput } = parsed.data;

    // Resolve the sandbox decision. When the server has no sandbox policy at all,
    // behavior is unchanged: every session is a normal, unconfined shell.
    let sandbox: SandboxSettings | undefined;
    if (sandboxCfg) {
      const wantSandbox = wantSandboxRaw ?? sandboxCfg.defaultOn;
      if (wantSandbox) {
        // Confine to the requested cwd, which must live within the sandbox root.
        const resolved = resolveSandboxDir(sandboxCfg.root, createInput.cwd);
        if (!resolved) {
          return reply.code(400).send({
            error: 'cwd_outside_sandbox_root',
            message: `working directory must be inside the sandbox root (${sandboxCfg.root})`,
          });
        }
        sandbox = sandboxCfg;
      } else {
        // A full read-write session is privileged: it requires the separate
        // bypass password, which agents are never given.
        const unsHash = opts.config?.unsandboxedHash;
        if (!unsHash) {
          return reply.code(403).send({
            error: 'unsandboxed_disabled',
            message: 'unsandboxed sessions are disabled; set a bypass password with `omas passwd --bypass`',
          });
        }
        const ip = (req as any).ip ?? 'unknown';
        if (opts.limiter?.isBlocked(ip)) {
          return reply.code(429).send({ error: 'too_many_attempts', message: 'too many bypass attempts; try again later' });
        }
        const ok = typeof bypass === 'string' && bypass.length > 0
          ? await verifyPassword(unsHash, bypass)
          : false;
        if (!ok) {
          opts.limiter?.recordFail(ip);
          return reply.code(401).send({ error: 'bad_bypass', message: 'invalid bypass password' });
        }
        opts.limiter?.recordSuccess(ip);
        sandbox = undefined; // explicit full-access session
      }
    }

    try {
      const s = hub.create({ ...createInput, sandbox });
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

  // One-shot command execution in the session's workspace (cwd), reusing the
  // session's sandbox confinement. Powers `omas exec` for external agents.
  app.post('/api/sessions/:id/exec', async (req: any, reply: any) => {
    const { id } = req.params as { id: string };
    const s = hub.get(id);
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const parsed = execSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const result = await s.exec(parsed.data.command, { timeoutMs: parsed.data.timeoutMs });
    return reply.send(result);
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

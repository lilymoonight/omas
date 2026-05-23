import { PtySession, type PtySessionOpts } from './session.js';
import { logger } from '../logger.js';

export type HubOpts = {
  maxSessions: number;
  scrollbackBytes: number;
  defaultShell?: string;
  defaultCwd?: string;
};

export class SessionHub {
  private readonly sessions = new Map<string, PtySession>();

  constructor(private readonly opts: HubOpts) {}

  list(): PtySession[] {
    return [...this.sessions.values()];
  }

  get(id: string): PtySession | undefined {
    return this.sessions.get(id);
  }

  create(input: Omit<PtySessionOpts, 'scrollbackBytes'> & { scrollbackBytes?: number }): PtySession {
    if (this.sessions.size >= this.opts.maxSessions) {
      throw new HubError('max_sessions_reached', `max ${this.opts.maxSessions} sessions`, 429);
    }
    const session = new PtySession({
      ...input,
      shell: input.shell ?? this.opts.defaultShell,
      cwd: input.cwd ?? this.opts.defaultCwd,
      scrollbackBytes: input.scrollbackBytes ?? this.opts.scrollbackBytes,
    });
    this.sessions.set(session.id, session);
    session.on('exit', () => {
      logger.info({ id: session.id, exitCode: session.exitCode }, 'pty exited; removing');
      this.sessions.delete(session.id);
    });
    logger.info({ id: session.id, shell: session.shell, cwd: session.cwd }, 'pty spawned');
    return session;
  }

  destroy(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill('SIGHUP');
    this.sessions.delete(id);
    return true;
  }

  async shutdownAll(): Promise<void> {
    const all = [...this.sessions.values()];
    for (const s of all) {
      s.kill('SIGHUP');
    }
    this.sessions.clear();
  }
}

export class HubError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

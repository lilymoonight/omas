import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionHub } from '../pty/hub.js';
import { shellCwd } from '../pty/shell-cwd.js';

const exec = promisify(execFile);

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

export type GitFile = {
  path: string;
  /** Index/staged status — single char per `git status --porcelain` */
  index: string;
  /** Worktree/unstaged status */
  worktree: string;
  /** For renames/copies, the previous path */
  oldPath?: string;
};

export type GitStatus =
  | {
      available: true;
      root: string;
      cwd: string;
      branch: { name: string | null; upstream: string | null; ahead: number; behind: number };
      files: GitFile[];
      truncated: boolean;
    }
  | { available: false; reason: 'not_a_repo' | 'git_not_installed' | 'error' | 'no_cwd'; message?: string; cwd?: string };

const MAX_FILES = 500;

async function gitStatus(cwd: string): Promise<GitStatus> {
  const opts = { cwd, timeout: 3000, maxBuffer: 4 * 1024 * 1024 };
  try {
    const { stdout: topOut } = await exec('git', ['rev-parse', '--show-toplevel'], opts);
    const root = topOut.trim();
    const [statusOut, branchOut] = await Promise.all([
      exec('git', ['status', '--porcelain=v1', '-uall', '-z'], { ...opts, cwd: root }).then((r) => r.stdout),
      exec('git', ['status', '--branch', '--porcelain=v2', '-z'], { ...opts, cwd: root })
        .then((r) => r.stdout)
        .catch(() => ''),
    ]);

    const files: GitFile[] = [];
    let truncated = false;
    const entries = statusOut.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.length < 3) continue;
      const X = e[0]!;
      const Y = e[1]!;
      const path = e.slice(3);
      let oldPath: string | undefined;
      // With -z, renames/copies emit NEW\0OLD as two entries
      if (X === 'R' || X === 'C') {
        oldPath = entries[++i];
      }
      if (files.length >= MAX_FILES) { truncated = true; break; }
      files.push({ path, index: X, worktree: Y, oldPath });
    }

    const branch = { name: null as string | null, upstream: null as string | null, ahead: 0, behind: 0 };
    for (const line of branchOut.split('\0')) {
      if (line.startsWith('# branch.head ')) branch.name = line.slice('# branch.head '.length);
      else if (line.startsWith('# branch.upstream ')) branch.upstream = line.slice('# branch.upstream '.length);
      else if (line.startsWith('# branch.ab ')) {
        const m = line.match(/\+(\d+) -(\d+)/);
        if (m) {
          branch.ahead = parseInt(m[1]!, 10);
          branch.behind = parseInt(m[2]!, 10);
        }
      }
    }

    return { available: true, root, cwd, branch, files, truncated };
  } catch (err: any) {
    const msg = String(err?.stderr ?? err?.message ?? err);
    if (/not a git repository/i.test(msg)) return { available: false, reason: 'not_a_repo', cwd };
    if (err?.code === 'ENOENT') return { available: false, reason: 'git_not_installed' };
    return { available: false, reason: 'error', message: msg, cwd };
  }
}

export function registerGitRoutes(app: App, hub: SessionHub): void {
  app.get('/api/sessions/:id/git-status', async (req: any, reply: any) => {
    const { id } = req.params;
    const session = hub.get(id);
    if (!session) return reply.code(404).send({ error: 'not_found' });
    // Prefer the shell's *current* cwd (tracks `cd` commands) over the spawn-time cwd.
    const cwd = (await shellCwd(session.pid)) ?? session.cwd;
    if (!cwd) return reply.send({ available: false, reason: 'no_cwd' });
    const result = await gitStatus(cwd);
    return result;
  });
}

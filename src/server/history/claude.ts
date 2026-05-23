import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { HistorySession } from './types.js';
import { cwdExists, resolveEncodedPath } from './encoded-path.js';

async function readHeadLines(file: string, max: number): Promise<unknown[]> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out: unknown[] = [];
  for await (const line of rl) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    if (out.length >= max) break;
  }
  rl.close();
  stream.destroy();
  return out;
}

async function countLines(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const s = fs.createReadStream(file);
    s.on('data', (chunk: any) => {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
    });
    s.on('end', () => resolve(count));
    s.on('error', reject);
  });
}

function pickTitle(entries: any[]): string | null {
  for (const e of entries) {
    if (e?.type === 'ai-title' && typeof e.aiTitle === 'string' && e.aiTitle.trim()) {
      return e.aiTitle.trim();
    }
  }
  for (const e of entries) {
    if (e?.type !== 'user') continue;
    const content = e.message?.content;
    if (typeof content !== 'string') continue;
    const t = content.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    return t.length > 120 ? t.slice(0, 120) + '…' : t;
  }
  return null;
}

function pickCwd(entries: any[]): string | null {
  for (const e of entries) if (typeof e?.cwd === 'string' && e.cwd) return e.cwd;
  return null;
}
function pickGitBranch(entries: any[]): string | null {
  for (const e of entries) if (typeof e?.gitBranch === 'string' && e.gitBranch) return e.gitBranch;
  return null;
}
function pickStartedAt(entries: any[]): string | null {
  for (const e of entries) if (typeof e?.timestamp === 'string') return e.timestamp;
  return null;
}

/** Fallback when canonical cwd isn't stored inside the jsonl. */
async function cwdFromProject(proj: string, head: unknown[]): Promise<string> {
  const encoded = proj.startsWith('-') ? proj : `-${proj}`;
  const fromEncoding = await resolveEncodedPath(encoded);
  const fromHead = pickCwd(head);
  if (fromHead && await cwdExists(fromHead)) return fromHead;
  return fromEncoding;
}

export async function scan(): Promise<HistorySession[]> {
  const root = path.join(os.homedir(), '.claude', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(root);
  } catch {
    return [];
  }
  const out: HistorySession[] = [];
  for (const proj of projectDirs) {
    const projDir = path.join(root, proj);
    let files: string[];
    try {
      files = (await fsp.readdir(projDir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(projDir, f);
      try {
        const [stat, head, lineCount] = await Promise.all([
          fsp.stat(file),
          readHeadLines(file, 200),
          countLines(file),
        ]);
        const id = path.basename(f, '.jsonl');
        const cwd = await cwdFromProject(proj, head);
        const exists = await cwdExists(cwd);
        const title = pickTitle(head) ?? '(无标题)';
        out.push({
          source: 'claude-code',
          id,
          cwd,
          cwdExists: exists,
          projectName: path.basename(cwd),
          title,
          gitBranch: pickGitBranch(head),
          startedAt: pickStartedAt(head),
          lastActivityAt: stat.mtime.toISOString(),
          messageCount: lineCount,
          resumeCommand: `claude --resume ${id}`,
          safeResumeCommand: null, // aggregator fills in when `ai-safe` is on PATH
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  return out;
}

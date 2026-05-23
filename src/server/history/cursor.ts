import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { HistorySession } from './types.js';
import { cwdExists, resolveEncodedPath } from './encoded-path.js';

/** Cursor agent stores transcripts at
 *    ~/.cursor/projects/<encoded>/agent-transcripts/<chatId>/<chatId>.jsonl
 *  The encoded dir name maps every `/` to `-` (ambiguous when a path
 *  component contains a literal `-`). Transcript lines themselves don't
 *  carry the canonical cwd, so we fall back to the decoded path. */

async function readHeadLines(file: string, max: number): Promise<unknown[]> {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out: unknown[] = [];
  for await (const line of rl) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* */ }
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
  // First user message — Cursor wraps user prompts in <user_query>…</user_query>.
  for (const e of entries) {
    if (e?.role !== 'user') continue;
    const parts = e.message?.content;
    if (!Array.isArray(parts)) continue;
    for (const p of parts) {
      if (p?.type !== 'text' || typeof p.text !== 'string') continue;
      let t = p.text.trim();
      const m = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(t);
      if (m) t = m[1]!.trim();
      t = t.replace(/\s+/g, ' ');
      if (!t) continue;
      return t.length > 120 ? t.slice(0, 120) + '…' : t;
    }
  }
  return null;
}

/** Cursor's encoding: leading slash dropped, `/` → `-` (ambiguous when a
 *  component contains literal `-`). Resolved via filesystem walk. */

export async function scan(): Promise<HistorySession[]> {
  const projectsRoot = path.join(os.homedir(), '.cursor', 'projects');
  let projects: string[];
  try {
    projects = await fsp.readdir(projectsRoot);
  } catch {
    return [];
  }
  const out: HistorySession[] = [];
  for (const proj of projects) {
    const transcriptsDir = path.join(projectsRoot, proj, 'agent-transcripts');
    let chatDirs: string[];
    try {
      chatDirs = await fsp.readdir(transcriptsDir);
    } catch {
      continue;
    }
    for (const chatId of chatDirs) {
      const chatDir = path.join(transcriptsDir, chatId);
      const transcript = path.join(chatDir, `${chatId}.jsonl`);
      try {
        const [stat, head, lineCount] = await Promise.all([
          fsp.stat(transcript),
          readHeadLines(transcript, 80),
          countLines(transcript),
        ]);
        const cwd = await resolveEncodedPath(proj);
        const exists = await cwdExists(cwd);
        const title = pickTitle(head) ?? '(无标题)';
        out.push({
          source: 'cursor-agent',
          id: chatId,
          cwd,
          cwdExists: exists,
          projectName: path.basename(cwd) || cwd,
          title,
          gitBranch: null,
          startedAt: null,
          lastActivityAt: stat.mtime.toISOString(),
          messageCount: lineCount,
          resumeCommand: `cursor-agent --resume ${chatId}`,
          safeResumeCommand: null,
        });
      } catch {
        // skip
      }
    }
  }
  return out;
}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { HistorySession } from './types.js';

async function countLines(file: string): Promise<number> {
  return new Promise((resolve) => {
    let count = 0;
    const s = fs.createReadStream(file);
    s.on('data', (chunk: any) => {
      const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) count++;
    });
    s.on('end', () => resolve(count));
    s.on('error', () => resolve(0));
  });
}

type QoderSessionMeta = {
  id: string;
  title?: string;
  message_count?: number;
  working_dir?: string;
  created_at?: number;
  updated_at?: number;
};

/** Qoder stores per-session metadata in <id>-session.json alongside the
 *  <id>.jsonl. That metadata gives us cwd + title + counts without parsing
 *  the (often huge) transcript file. */
export async function scan(): Promise<HistorySession[]> {
  const root = path.join(os.homedir(), '.qoder', 'projects');
  let projectDirs: string[];
  try {
    projectDirs = await fsp.readdir(root);
  } catch {
    return [];
  }
  const out: HistorySession[] = [];
  for (const proj of projectDirs) {
    const projDir = path.join(root, proj);
    let entries: string[];
    try {
      entries = await fsp.readdir(projDir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith('-session.json')) continue;
      const metaFile = path.join(projDir, f);
      try {
        const [stat, raw] = await Promise.all([
          fsp.stat(metaFile),
          fsp.readFile(metaFile, 'utf8'),
        ]);
        const meta = JSON.parse(raw) as QoderSessionMeta;
        if (!meta.id) continue;
        const cwd = meta.working_dir ?? '';
        if (!cwd) continue;
        let cwdExists = false;
        try { cwdExists = (await fsp.stat(cwd)).isDirectory(); } catch { /* */ }
        // Qoder writes message_count = 0 on disk most of the time, so derive
        // an approximation from the transcript line count.
        let msgCount = meta.message_count ?? 0;
        if (msgCount === 0) {
          const transcript = path.join(projDir, `${meta.id}.jsonl`);
          msgCount = await countLines(transcript).catch(() => 0);
        }
        out.push({
          source: 'qoder',
          id: meta.id,
          cwd,
          cwdExists,
          projectName: path.basename(cwd) || cwd,
          title: meta.title?.trim() || '(无标题)',
          gitBranch: null,
          startedAt: meta.created_at ? new Date(meta.created_at).toISOString() : null,
          lastActivityAt: (meta.updated_at
            ? new Date(meta.updated_at)
            : stat.mtime).toISOString(),
          messageCount: msgCount,
          // The qoder CLI binary is `qodercli`; `qoder` is just an informal
          // alias users sometimes set. Use the canonical name.
          resumeCommand: `qodercli -r ${meta.id}`,
          safeResumeCommand: null,
        });
      } catch {
        // skip
      }
    }
  }
  return out;
}

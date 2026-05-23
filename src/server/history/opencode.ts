import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { HistorySession } from './types.js';

/** OpenCode stores sessions in a SQLite db at
 *    ~/.local/share/opencode/opencode.db
 *  We open it READONLY so a running opencode (which holds a WAL write lock)
 *  doesn't block us — and so we don't risk corrupting the user's data.
 *  node:sqlite landed stable in Node 22. */

type Row = {
  id: string;
  title: string | null;
  directory: string | null;
  time_created: number | null;
  time_updated: number | null;
  msg_count: number | null;
};

export async function scan(): Promise<HistorySession[]> {
  const dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
  try {
    await fsp.access(dbPath);
  } catch {
    return [];
  }
  let DatabaseSync: typeof import('node:sqlite').DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return []; // running on a Node without node:sqlite (shouldn't happen on 22)
  }

  let db: import('node:sqlite').DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }

  let rows: Row[] = [];
  try {
    rows = db.prepare(`
      SELECT
        s.id           AS id,
        s.title        AS title,
        s.directory    AS directory,
        s.time_created AS time_created,
        s.time_updated AS time_updated,
        (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) AS msg_count
      FROM session s
      ORDER BY s.time_updated DESC
      LIMIT 500
    `).all() as unknown as Row[];
  } catch {
    db.close();
    return [];
  }
  db.close();

  const out: HistorySession[] = [];
  for (const r of rows) {
    if (!r.id) continue;
    const cwd = r.directory ?? '';
    if (!cwd) continue;
    let cwdExists = false;
    try { cwdExists = (await fsp.stat(cwd)).isDirectory(); } catch { /* */ }
    out.push({
      source: 'opencode',
      id: r.id,
      cwd,
      cwdExists,
      projectName: path.basename(cwd) || cwd,
      title: (r.title ?? '').trim() || '(无标题)',
      gitBranch: null,
      startedAt: r.time_created ? new Date(r.time_created).toISOString() : null,
      lastActivityAt: (r.time_updated
        ? new Date(r.time_updated)
        : (r.time_created ? new Date(r.time_created) : new Date())).toISOString(),
      messageCount: r.msg_count ?? 0,
      resumeCommand: `opencode --session ${r.id}`,
      safeResumeCommand: null,
    });
  }
  return out;
}

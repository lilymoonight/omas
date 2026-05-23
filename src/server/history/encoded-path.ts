import fsp from 'node:fs/promises';
import path from 'node:path';

/** Naive decode used by Cursor/Claude metadata dirs: `/` → `-`. Breaks when a
 *  path component contains hyphens (e.g. `oh-my-agent-shell` → `oh/my/agent/shell`). */
export function decodeEncodedPathNaive(encoded: string): string {
  const stripped = encoded.startsWith('-') ? encoded.slice(1) : encoded;
  if (!stripped) return '/';
  return '/' + stripped.replace(/-/g, '/');
}

/** Resolve an encoded project key to the longest existing directory path. */
export async function resolveEncodedPath(encoded: string): Promise<string> {
  const naive = decodeEncodedPathNaive(encoded);
  if (await isDir(naive)) return naive;

  const raw = encoded.startsWith('-') ? encoded.slice(1) : encoded;
  const tokens = raw.split('-').filter(Boolean);
  if (tokens.length === 0) return naive;

  let current = path.resolve('/', tokens[0]!);
  if (!(await isDir(current))) return naive;

  let i = 1;
  while (i < tokens.length) {
    let advanced = false;
    // Longest match first so `oh-my-agent-shell` wins over `oh`.
    for (let j = tokens.length; j > i; j--) {
      for (const segment of segmentCandidates(current, tokens, i, j)) {
        const candidate = path.join(current, segment);
        if (await isDir(candidate)) {
          current = candidate;
          i = j;
          advanced = true;
          break;
        }
      }
      if (advanced) break;
    }
    if (!advanced) break;
  }
  return current;
}

/** Directory-name variants for greedy walk (hyphens / macOS /var/folders/_xx). */
function segmentCandidates(current: string, tokens: string[], i: number, j: number): string[] {
  const joined = tokens.slice(i, j).join('-');
  const out = [joined];
  if (j === i + 1) out.push(`_${joined}`);
  // /var/folders/_q/_<hash>/T/<uuid-with-hyphens>
  if (current.endsWith(`${path.sep}T`) && j === tokens.length) out.push(joined);
  return out;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function cwdExists(p: string): Promise<boolean> {
  return isDir(p);
}

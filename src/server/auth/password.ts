import argon2 from 'argon2';

// Argon2id is the modern default (RFC 9106). Defaults here favor interactive
// auth — single-user CLI tool, not a Web-scale auth service.
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 6) throw new Error('password must be at least 6 characters');
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

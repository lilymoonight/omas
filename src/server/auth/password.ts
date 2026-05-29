// Argon2id is the modern default (RFC 9106). Defaults here favor interactive
// auth — single-user CLI tool, not a Web-scale auth service.
//
// The shipped product is a Bun-compiled single binary; the `argon2` npm package
// is a *native* addon (node-gyp-build loads a prebuilt `.node`) which can't be
// embedded into a `bun build --compile` binary — at runtime it fails with
// "no native build was found for argon2". So under Bun we use the built-in
// `Bun.password` (argon2id, no native addon). Under Node (dev/tests) we lazily
// load the `argon2` package. Both emit/verify standard PHC strings, so hashes
// are cross-compatible between the two runtimes.
const MEMORY_COST = 19 * 1024; // 19 MiB, in KiB
const TIME_COST = 2;
const PARALLELISM = 1;

const isBun = typeof (process.versions as { bun?: string }).bun === 'string';

export async function hashPassword(plain: string): Promise<string> {
  if (plain.length < 6) throw new Error('password must be at least 6 characters');
  if (isBun) {
    return Bun.password.hash(plain, {
      algorithm: 'argon2id',
      memoryCost: MEMORY_COST,
      timeCost: TIME_COST,
    });
  }
  const argon2 = (await import('argon2')).default;
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: MEMORY_COST,
    timeCost: TIME_COST,
    parallelism: PARALLELISM,
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    if (isBun) return await Bun.password.verify(plain, hash);
    const argon2 = (await import('argon2')).default;
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

// Runtime-switching PTY factory. Under Node we use the prebuilt node-pty
// addon; under Bun we use Bun.spawn({pty: true}) + bun:ffi for ioctl
// resize. Both expose the same minimal IPty interface.
//
// Neither backend is imported statically — node-pty pulls in a .node addon
// that breaks Bun --compile, and backend-bun uses bun:ffi which Node can't
// load. Both are resolved dynamically at startup.

export type IPty = {
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
  onData(cb: (data: Buffer) => void): void;
  onExit(cb: (info: { exitCode: number; signal: number | string }) => void): void;
  write(s: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

export type SpawnOpts = {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
};

const isBun = typeof (process.versions as any).bun === 'string';

type NodeSpawn = (
  file: string,
  args: string[] | string,
  options: Record<string, unknown>,
) => unknown;

let bunSpawn: ((file: string, args: string[], opts: SpawnOpts) => IPty) | null = null;
let nodeSpawn: NodeSpawn | null = null;

async function init(): Promise<void> {
  if (isBun) {
    const mod = await import(
      process.platform === 'darwin' ? './backend-bun-darwin.js' : './backend-bun.js',
    );
    bunSpawn = mod.spawn as any;
    return;
  }
  const mod = await import('@homebridge/node-pty-prebuilt-multiarch');
  nodeSpawn = mod.spawn.bind(mod) as NodeSpawn;
}
const ready: Promise<void> = init();

export async function ensureReady(): Promise<void> { await ready; }

/** node-pty delivers decoded strings; normalize to raw bytes for the rest of the stack. */
function wrapNodePty(pty: IPty & { onData(cb: (data: string | Buffer) => void): void }): IPty {
  return {
    get pid() { return pty.pid; },
    get cols() { return pty.cols; },
    get rows() { return pty.rows; },
    onData(cb: (data: Buffer) => void) {
      pty.onData((data) => cb(typeof data === 'string' ? Buffer.from(data, 'utf8') : data));
    },
    onExit: pty.onExit.bind(pty),
    write: pty.write.bind(pty),
    resize: pty.resize.bind(pty),
    kill: pty.kill.bind(pty),
  };
}

export function spawn(file: string, args: string[], opts: SpawnOpts): IPty {
  if (isBun) {
    if (!bunSpawn) {
      throw new Error('Bun PTY backend not initialised; await ensureReady() before spawn');
    }
    return bunSpawn(file, args, opts);
  }
  if (!nodeSpawn) {
    throw new Error('Node PTY backend not initialised; await ensureReady() before spawn');
  }
  return wrapNodePty(nodeSpawn(file, args, opts) as IPty & {
    onData(cb: (data: string | Buffer) => void): void;
  });
}

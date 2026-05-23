import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

type App = {
  get: (path: string, handler: (req: any, reply: any) => any) => unknown;
};

// CPU percent needs two samples. Keep the previous one at module scope.
let lastCpu: { total: number; idle: number } | null = null;
function cpuSample(): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { total, idle };
}

type Gpu = {
  index: number;
  name: string;
  utilization: number; // 0..100
  memoryUsed: number;  // bytes
  memoryTotal: number; // bytes
  temperature: number; // C
};

// Cache GPU snapshot for ~2s so per-second polling doesn't fork nvidia-smi too often.
let gpuCache: { at: number; gpus: Gpu[] | null } = { at: 0, gpus: null };
let gpuSupported: boolean | null = null;
// Once we've successfully read GPUs we keep the last good snapshot indefinitely;
// transient nvidia-smi timeouts shouldn't make the panel disappear.
let gpuLastGood: { at: number; gpus: Gpu[] } | null = null;
// Run only one nvidia-smi at a time so back-to-back polls don't pile up.
let gpuInFlight: Promise<Gpu[] | null> | null = null;

async function readGpus(): Promise<Gpu[] | null> {
  if (gpuSupported === false) return null;
  const now = Date.now();
  if (gpuCache.gpus && now - gpuCache.at < 1500) return gpuCache.gpus;

  // Coalesce concurrent calls onto a single nvidia-smi exec.
  if (!gpuInFlight) {
    gpuInFlight = (async () => {
      try {
        const { stdout } = await exec(
          'nvidia-smi',
          ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu',
           '--format=csv,noheader,nounits'],
          { timeout: 2500 },
        );
        const gpus: Gpu[] = [];
        for (const line of stdout.trim().split('\n')) {
          const parts = line.split(',').map((s) => s.trim());
          if (parts.length < 6) continue;
          gpus.push({
            index: parseInt(parts[0]!, 10),
            name: parts[1]!,
            utilization: parseFloat(parts[2]!) || 0,
            memoryUsed: (parseFloat(parts[3]!) || 0) * 1024 * 1024,
            memoryTotal: (parseFloat(parts[4]!) || 0) * 1024 * 1024,
            temperature: parseFloat(parts[5]!) || 0,
          });
        }
        gpuSupported = true;
        gpuCache = { at: Date.now(), gpus };
        gpuLastGood = { at: Date.now(), gpus };
        return gpus;
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          // nvidia-smi truly absent — short-circuit forever
          gpuSupported = false;
          gpuLastGood = null;
        }
        return null;
      } finally {
        gpuInFlight = null;
      }
    })();
  }

  const fresh = await gpuInFlight;
  if (fresh) return fresh;
  // Fresh read failed (timeout, signal, weird CSV). If we ever saw GPUs on
  // this host, keep showing the last good snapshot so the UI doesn't flicker.
  return gpuLastGood?.gpus ?? null;
}

export function registerSystemRoutes(app: App): void {
  app.get('/api/system/stats', async () => {
    const cur = cpuSample();
    let cpuPercent = 0;
    if (lastCpu) {
      const dt = cur.total - lastCpu.total;
      const di = cur.idle - lastCpu.idle;
      if (dt > 0) cpuPercent = Math.max(0, Math.min(100, ((dt - di) / dt) * 100));
    }
    lastCpu = cur;

    let disk: { total: number; free: number; used: number; path: string } | null = null;
    try {
      const path = process.cwd();
      const s = await fs.statfs(path);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      disk = { total, free, used: total - free, path };
    } catch {
      // statfs unsupported on some platforms; just omit the field
    }

    const totalmem = os.totalmem();
    const freemem = os.freemem();
    const gpus = await readGpus();
    return {
      cpu: { percent: cpuPercent, cores: os.cpus().length },
      memory: { total: totalmem, free: freemem, used: totalmem - freemem },
      load: os.loadavg(),
      disk,
      gpus,
      uptime: os.uptime(),
      processUptime: process.uptime(),
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
    };
  });
}

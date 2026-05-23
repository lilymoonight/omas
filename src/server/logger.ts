import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';
// pino-pretty uses a worker thread that pulls in `real-require` dynamically;
// when our code is shipped as a single Bun-compiled binary, that dynamic
// resolve fails and the worker crashes the whole process at startup. So we
// skip the pretty transport under Bun even in dev — the JSON one-liner output
// is fine for headless deployments anyway.
// `process.versions.bun` is set when running under Bun, undefined under Node.
const isBun = typeof (process.versions as any).bun === 'string';
const usePretty = isDev && !isBun;

export const logger = pino(
  usePretty
    ? {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
      }
    : { level: process.env.LOG_LEVEL ?? 'info' },
);

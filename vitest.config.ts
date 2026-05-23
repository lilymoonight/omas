import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    // Native PTY needs a real child process, not a worker thread.
    pool: 'forks',
  },
});

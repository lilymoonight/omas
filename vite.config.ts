import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// base:'./' is the key to working under arbitrary reverse-proxy paths (VSCode tunnels, nginx /foo/, etc).
export default defineConfig({
  root: 'src/web',
  base: './',
  plugins: [svelte()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/@codemirror') || id.includes('node_modules/codemirror')) {
            return 'codemirror';
          }
          if (id.includes('node_modules/@xterm')) return 'xterm';
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7681',
        ws: true,
        changeOrigin: false,
      },
    },
  },
});

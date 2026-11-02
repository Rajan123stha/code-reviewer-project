import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const client = fileURLToPath(new URL('./src/client', import.meta.url));

// The single-page client. The server (src/server) serves its build and the JSON API.
export default defineConfig({
  root: client,
  base: './',
  // The client needs no configuration: never load .env files into the bundle, so no
  // VITE_-prefixed (or any other) variable can leak into code shipped to browsers.
  envDir: false,
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // `pnpm dev:client` talks to `pnpm dev:server`.
    // changeOrigin sends Host: 127.0.0.1:4000, which the server's host check accepts.
    proxy: { '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true } },
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    // Run tests against workspace package sources, so no build step is needed first.
    alias: [{ find: /^@reviewlens\/([^/]+)$/, replacement: `${root}packages/$1/src/index.ts` }],
  },
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});

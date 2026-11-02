import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

// Tests that start an in-memory Postgres (PGlite, WebAssembly). Each instance is large; several
// at once crashed test workers on a low-memory machine, so these files run one at a time.
const DATABASE_TESTS = ['packages/db/src/**/*.test.ts'];

export default defineConfig({
  resolve: {
    // Run tests against workspace package sources, so no build step is needed first.
    alias: [{ find: /^@reviewlens\/([^/]+)$/, replacement: `${root}packages/$1/src/index.ts` }],
  },
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
          exclude: [...DATABASE_TESTS, '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: { name: 'database', include: DATABASE_TESTS, fileParallelism: false },
      },
    ],
  },
});

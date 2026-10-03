// Test helper; not exported from the package index.
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createDb, type Db } from './client.js';

const MIGRATIONS = new URL('../prisma/migrations/', import.meta.url);

/**
 * Real Postgres semantics without a server: PGlite (Postgres compiled to WASM) behind a
 * wire-protocol socket, with the committed migrations applied in order. Tables are
 * truncated before each test.
 */
export function useTestDb(): () => Db {
  let pglite: PGlite;
  let server: PGLiteSocketServer;
  let db: Db;

  beforeAll(async () => {
    pglite = await PGlite.create({ extensions: { vector } });
    const dirs = (await readdir(MIGRATIONS, { withFileTypes: true })).filter((d) =>
      d.isDirectory(),
    );
    for (const dir of dirs.map((d) => d.name).sort()) {
      await pglite.exec(await readFile(new URL(`${dir}/migration.sql`, MIGRATIONS), 'utf8'));
    }
    const port = 54_000 + Math.floor(Math.random() * 1_000);
    server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
    await server.start();
    db = createDb(`postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, {
      maxConnections: 1,
    });
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    await server?.stop();
    await pglite?.close();
  });

  beforeEach(async () => {
    await db.$executeRawUnsafe(
      'TRUNCATE chunks, bug_history, conventions, embedding_cache, edges, symbols, files, parsed_blobs, candidate_comments, reviews, pull_requests, repositories, installations RESTART IDENTITY CASCADE',
    );
  });

  return () => db;
}

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileAtomic } from './atomic-write.js';

describe('writeFileAtomic', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('creates parent directories and leaves no temp files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-'));
    const path = join(dir, 'a', 'b', 'file.json');
    await writeFileAtomic(path, '{"x":1}');
    expect(await readFile(path, 'utf8')).toBe('{"x":1}');
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['file.json']);
  });

  it('survives many concurrent writers to the same path', async () => {
    dir = await mkdtemp(join(tmpdir(), 'atomic-'));
    const path = join(dir, 'same.json');
    await Promise.all(Array.from({ length: 40 }, () => writeFileAtomic(path, 'same content')));
    expect(await readFile(path, 'utf8')).toBe('same content');
    expect(await readdir(dir)).toEqual(['same.json']);
  });
});

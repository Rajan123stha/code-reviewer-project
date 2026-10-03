import { describe, expect, it } from 'vitest';
import { parseGitLog } from './history.js';
import { parseLsTree } from './snapshot.js';

const RS = '\x1e';
const US = '\x1f';

describe('parseGitLog', () => {
  it('keeps fix commits with their files and skips everything else', () => {
    const log = [
      `${RS}${'a'.repeat(40)}${US}2026-09-12T10:00:00+02:00${US}Fix stale entries when merging\n\nArrays kept old items.\n${US}\n\nsource/merge.ts\ntest/merge.ts\n`,
      `${RS}${'b'.repeat(40)}${US}2026-09-11T10:00:00+02:00${US}Add maxResponseSize option\n${US}\n\nsource/index.ts\n`,
      `${RS}${'c'.repeat(40)}${US}2026-09-10T10:00:00+02:00${US}docs: fix typo\n${US}\n\nreadme.md\n`,
    ].join('');
    expect(parseGitLog(log)).toEqual([
      {
        sha: 'a'.repeat(40),
        committedAt: '2026-09-12T10:00:00+02:00',
        summary: 'Fix stale entries when merging — Arrays kept old items.',
        files: ['source/merge.ts', 'test/merge.ts'],
      },
    ]);
  });

  it('handles empty output', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

describe('parseLsTree', () => {
  it('reads blobs with sizes and skips symlinks and submodules', () => {
    const out = [
      `100644 blob ${'1'.repeat(40)}     120\tsrc/a b.ts`,
      `120000 blob ${'2'.repeat(40)}      10\tlink`,
      `160000 commit ${'3'.repeat(40)}       -\tvendor/lib`,
      '',
    ].join('\0');
    expect(parseLsTree(out)).toEqual([{ path: 'src/a b.ts', blobSha: '1'.repeat(40), size: 120 }]);
  });
});

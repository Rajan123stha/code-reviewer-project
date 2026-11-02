import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  gitBlobSha,
  languageFor,
  MAX_INDEX_FILE_BYTES,
  type RepoFileEntry,
} from '@reviewlens/context-engine';
import { MAX_FILE_BYTES } from '@reviewlens/github';
import type { RepoSnapshot } from '@reviewlens/review-core';

const exec = promisify(execFile);
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/** Snapshot over a checked-out working tree. Refuses paths that escape the root. */
export function directorySnapshot(root: string, sha = 'working-tree'): RepoSnapshot {
  const base = resolve(root);
  const readSafe = async (path: string) => {
    const full = resolve(base, path);
    const rel = relative(base, full);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    try {
      if ((await stat(full)).size > MAX_FILE_BYTES) return null;
      return await readFile(full, 'utf8');
    } catch {
      return null;
    }
  };
  return {
    sha,
    readFile: readSafe,
    async listFiles() {
      const entries: RepoFileEntry[] = [];
      const walk = async (dir: string) => {
        for (const d of await readdir(dir, { withFileTypes: true })) {
          if (d.isSymbolicLink()) continue;
          const full = join(dir, d.name);
          if (d.isDirectory()) {
            if (!SKIP_DIRS.has(d.name)) await walk(full);
            continue;
          }
          const path = relative(base, full).split(sep).join('/');
          const { size } = await stat(full);
          // Only source files need a real content address; others are never parsed.
          const indexable = languageFor(path) !== null && size <= MAX_INDEX_FILE_BYTES;
          const blobSha = indexable ? gitBlobSha(await readFile(full)) : `unhashed:${path}`;
          entries.push({ path, blobSha, size });
        }
      };
      await walk(base);
      return entries;
    },
  };
}

/**
 * Snapshot of a commit in a local git repository. Files are read through one long-lived
 * `git cat-file --batch` process and listed with `git ls-tree`; git only reads objects,
 * nothing from the repository is executed, and textconv/filters do not apply.
 */
export function gitSnapshot(repoDir: string, sha: string): RepoSnapshot & { close(): void } {
  const reader = new GitBatchReader(repoDir);
  return {
    sha,
    readFile: (path) => reader.read(`${sha}:${path}`),
    async listFiles() {
      const { stdout } = await exec('git', ['-C', repoDir, 'ls-tree', '-r', '-l', '-z', sha], {
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
      });
      return parseLsTree(stdout);
    },
    close: () => reader.close(),
  };
}

/**
 * Minimal client for `git cat-file --batch`: requests are answered in order, each as
 * `<oid> <type> <size>\n<bytes>\n`, or `<name> missing\n`.
 */
class GitBatchReader {
  private proc: ChildProcessWithoutNullStreams | undefined;
  private buffer = Buffer.alloc(0);
  private readonly pending: { resolve: (v: string | null) => void; reject: (e: Error) => void }[] =
    [];

  constructor(private readonly repoDir: string) {}

  read(object: string): Promise<string | null> {
    if (/[\r\n]/.test(object)) return Promise.resolve(null);
    const proc = this.start();
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.hold(true);
      proc.stdin.write(object + '\n');
    });
  }

  /**
   * Keep Node's event loop alive only while answers are outstanding, so an idle reader
   * never blocks process exit and a busy one is never cut off.
   */
  private hold(active: boolean) {
    const proc = this.proc;
    if (!proc) return;
    for (const handle of [proc, proc.stdin, proc.stdout, proc.stderr]) {
      const h = handle as unknown as { ref?: () => void; unref?: () => void };
      if (active) h.ref?.();
      else h.unref?.();
    }
  }

  close() {
    this.proc?.stdin.end();
    this.proc = undefined;
  }

  private start(): ChildProcessWithoutNullStreams {
    if (this.proc) return this.proc;
    const proc = spawn('git', ['-C', this.repoDir, 'cat-file', '--batch'], { stdio: 'pipe' });
    proc.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    const fail = (error: Error) => {
      for (const p of this.pending.splice(0)) p.reject(error);
      this.proc = undefined;
    };
    proc.on('error', fail);
    proc.on('exit', (code) => {
      if (this.pending.length) fail(new Error(`git cat-file exited with code ${code}`));
    });
    this.proc = proc;
    this.hold(false);
    return proc;
  }

  private drain() {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (this.pending.length === 0) return this.hold(false);
      if (newline < 0) return;
      const header = this.buffer.subarray(0, newline).toString('utf8');
      if (header.endsWith(' missing') || header.endsWith(' ambiguous')) {
        this.buffer = this.buffer.subarray(newline + 1);
        this.pending.shift()!.resolve(null);
        continue;
      }
      const [, type, sizeText] = header.split(' ');
      const size = Number(sizeText);
      if (this.buffer.length < newline + 1 + size + 1) return; // wait for the rest
      const body = this.buffer.subarray(newline + 1, newline + 1 + size);
      this.buffer = this.buffer.subarray(newline + 1 + size + 1);
      const tooBig = size > MAX_FILE_BYTES;
      this.pending.shift()!.resolve(type === 'blob' && !tooBig ? body.toString('utf8') : null);
    }
  }
}

/** Parse `git ls-tree -r -l -z`: `<mode> <type> <object> <size>\t<path>\0`. */
export function parseLsTree(output: string): RepoFileEntry[] {
  const entries: RepoFileEntry[] = [];
  for (const record of output.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab < 0) continue;
    const [mode, type, object, size] = record.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || mode === '120000' || !object) continue;
    entries.push({ path: record.slice(tab + 1), blobSha: object, size: Number(size) });
  }
  return entries;
}

/**
 * Revisions reach git as command-line arguments. One starting with "-" would be read as an
 * option (git diff --output=<file> writes files), so only revision-shaped values pass.
 */
export function assertRevision(rev: string): string {
  if (!/^[A-Za-z0-9._/@{}^~:+-]{1,255}$/.test(rev) || rev.startsWith('-')) {
    throw new Error('not a valid git revision');
  }
  return rev;
}

/** Resolve a revision (branch, tag, HEAD~1) to a commit SHA. */
export async function gitRevParse(repoDir: string, rev: string): Promise<string> {
  assertRevision(rev);
  const { stdout } = await exec(
    'git',
    ['-C', repoDir, 'rev-parse', '--verify', `${rev}^{commit}`],
    {
      encoding: 'utf8',
    },
  );
  return stdout.trim();
}

/** Three-dot diff (merge-base to head), the same comparison a GitHub PR shows. */
export async function gitDiff(repoDir: string, base: string, head: string): Promise<string> {
  assertRevision(base);
  assertRevision(head);
  const { stdout } = await exec(
    'git',
    ['-C', repoDir, 'diff', '--no-color', '--no-ext-diff', '--no-textconv', `${base}...${head}`],
    { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
  );
  return stdout;
}

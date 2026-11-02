import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One scored experiment: `eval/results/<name>/<spec hash>/summary.json`. */
export interface ExperimentEntry {
  name: string;
  hash: string;
  description: string;
  scoredAt: string | null;
  arms: string[];
  cases: number;
  runs: number;
}

export interface ExperimentSource {
  list(): Promise<ExperimentEntry[]>;
  /** The summary exactly as the harness wrote it, or null if there is none. */
  read(name: string, hash: string): Promise<unknown>;
}

// Directory names come from URLs; only plain names are accepted, so a request can never
// walk out of the results directory.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function subdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && SAFE_NAME.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

interface SummaryShape {
  description?: string;
  scored_at?: string;
  runs?: number;
  cases_complete_in_all_arms?: number;
  arms?: { arm: string }[];
}

/** Reads the harness's result files. Experiments that were run but never scored are skipped. */
export function fileExperiments(root: string): ExperimentSource {
  return {
    async list() {
      const out: ExperimentEntry[] = [];
      for (const name of await subdirectories(root)) {
        for (const hash of await subdirectories(join(root, name))) {
          const summary = (await readJson(
            join(root, name, hash, 'summary.json'),
          )) as SummaryShape | null;
          if (!summary) continue;
          out.push({
            name,
            hash,
            description: summary.description ?? '',
            scoredAt: summary.scored_at ?? null,
            arms: (summary.arms ?? []).map((a) => a.arm),
            cases: summary.cases_complete_in_all_arms ?? 0,
            runs: summary.runs ?? 0,
          });
        }
      }
      return out.sort((a, b) => (b.scoredAt ?? '').localeCompare(a.scoredAt ?? ''));
    },
    async read(name, hash) {
      if (!SAFE_NAME.test(name) || !SAFE_NAME.test(hash)) return null;
      return readJson(join(root, name, hash, 'summary.json'));
    },
  };
}

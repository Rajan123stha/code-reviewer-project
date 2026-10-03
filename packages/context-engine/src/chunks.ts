import type { GraphSymbol, RepoGraph } from './graph.js';

export interface Chunk {
  /** Global id of the symbol this chunk is. */
  gid: number;
  path: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  /** Text that gets embedded: a location header plus the (possibly truncated) body. */
  text: string;
}

/** Bodies longer than this are truncated for embedding; the head carries most signal. */
export const MAX_CHUNK_CHARS = 6_000;
const MIN_CHUNK_LINES = 2;

/**
 * Symbol-level chunks of a repository: one per function, method, interface, type, enum
 * and multi-line module variable. Classes are covered by their methods; a class with no
 * methods is one chunk. One-line symbols carry too little to retrieve on and are skipped.
 *
 * Deterministic: chunks come out in graph order (sorted paths, then position).
 */
export async function buildChunks(
  graph: RepoGraph,
  readFile: (path: string) => Promise<string | null>,
): Promise<Chunk[]> {
  const chunks: Chunk[] = [];
  for (const path of graph.paths) {
    const symbols = graph.symbolsIn(path);
    const withMethods = new Set(
      symbols.filter((s) => s.kind === 'method' && s.parentGid !== null).map((s) => s.parentGid!),
    );
    const wanted = symbols.filter((s) => isChunkable(s, withMethods));
    if (wanted.length === 0) continue;
    const content = await readFile(path);
    if (content === null) continue;
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    for (const s of wanted) {
      const body = lines.slice(s.startLine - 1, s.endLine).join('\n');
      chunks.push({
        gid: s.gid,
        path,
        qualifiedName: s.qualifiedName,
        startLine: s.startLine,
        endLine: s.endLine,
        text: chunkText(path, s.qualifiedName, body),
      });
    }
  }
  return chunks;
}

export function chunkText(path: string, name: string, body: string): string {
  const clipped = body.length > MAX_CHUNK_CHARS ? body.slice(0, MAX_CHUNK_CHARS) : body;
  return `// ${path} :: ${name}\n${clipped}`;
}

function isChunkable(s: GraphSymbol, classesWithMethods: ReadonlySet<number>): boolean {
  if (s.kind === 'module') return false;
  if (s.endLine - s.startLine + 1 < MIN_CHUNK_LINES) return false;
  if (s.kind === 'class') return !classesWithMethods.has(s.gid);
  return true;
}

export interface ScoredChunk {
  chunk: Chunk;
  /** Highest cosine similarity to any query. */
  score: number;
}

/**
 * Rank chunks by their best similarity to any query vector. Vectors must be unit length
 * (EmbeddingClient normalizes), so similarity is a dot product. Ties break by graph order,
 * which keeps the ranking deterministic.
 */
export function rankChunks(
  chunks: readonly Chunk[],
  chunkVectors: readonly (readonly number[])[],
  queryVectors: readonly (readonly number[])[],
): ScoredChunk[] {
  const scored = chunks.map((chunk, i) => {
    let score = -Infinity;
    for (const q of queryVectors) {
      const v = chunkVectors[i]!;
      let sum = 0;
      for (let k = 0; k < v.length; k++) sum += v[k]! * q[k]!;
      if (sum > score) score = sum;
    }
    return { chunk, score };
  });
  return scored.sort((a, b) => b.score - a.score || a.chunk.gid - b.chunk.gid);
}

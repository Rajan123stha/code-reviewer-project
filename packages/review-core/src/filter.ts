import { z } from 'zod';
import { FEATURES_VERSION, type CandidateFeatures } from './features.js';

export interface ScoreResult {
  /** Identifies the trained model that produced the scores (a hash of its artifact). */
  modelVersion: string;
  featuresVersion: string;
  /** Estimated probability that each comment is useful, in the order of the request. */
  scores: number[];
}

/**
 * Scores candidate comments for usefulness. A scorer must be deterministic for a model
 * version: the pipeline records that version, so a review stays a function of its inputs.
 */
export interface CommentScorer {
  score(items: readonly CandidateFeatures[]): Promise<ScoreResult>;
}

const scoreResponseSchema = z.object({
  model_version: z.string().min(1),
  features_version: z.string().min(1),
  scores: z.array(z.number().min(0).max(1)),
});

export interface HttpScorerOptions {
  /** Base URL of the filter service, e.g. http://localhost:8000. */
  url: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Client for the filter service's `POST /score`. */
export class HttpCommentScorer implements CommentScorer {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetch: typeof fetch;

  constructor(options: HttpScorerOptions) {
    this.url = `${options.url.replace(/\/+$/, '')}/score`;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetch = options.fetch ?? fetch;
  }

  async score(items: readonly CandidateFeatures[]): Promise<ScoreResult> {
    const response = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features_version: FEATURES_VERSION, items }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`filter service returned ${response.status}: ${detail}`);
    }
    const body = scoreResponseSchema.parse(await response.json());
    return {
      modelVersion: body.model_version,
      featuresVersion: body.features_version,
      scores: body.scores,
    };
  }
}

/** Check a scorer's answer before the pipeline acts on it. */
export function assertScoreResult(
  result: ScoreResult,
  expected: { count: number; model: string | null },
): void {
  if (result.featuresVersion !== FEATURES_VERSION) {
    throw new Error(
      `filter model expects ${result.featuresVersion} but the pipeline computes ${FEATURES_VERSION}`,
    );
  }
  if (expected.model !== null && result.modelVersion !== expected.model) {
    throw new Error(
      `config pins filter model ${expected.model} but the scorer serves ${result.modelVersion}`,
    );
  }
  if (result.scores.length !== expected.count) {
    throw new Error(
      `filter returned ${result.scores.length} scores for ${expected.count} comments`,
    );
  }
  if (result.scores.some((s) => !(s >= 0 && s <= 1))) {
    throw new Error('filter returned a score outside 0..1');
  }
}

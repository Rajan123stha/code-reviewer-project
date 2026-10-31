import type { Effort, LLMClient } from '@reviewlens/llm';
import { z } from 'zod';
import { loadPrompt, renderTemplate } from './prompts.js';
import type { ModelComment } from './schema.js';

export const VERIFY_VERDICTS = ['upheld', 'refuted', 'uncertain'] as const;
export type VerifyVerdict = (typeof VERIFY_VERDICTS)[number];

/** Part of the LLM cache key and stored with each review: bump on any change of shape. */
export const VERIFY_SCHEMA_NAME = 'verify-verdicts/v1';

export const verifyOutputSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.number().int().describe('The id of the comment this verdict is about'),
      verdict: z.enum(VERIFY_VERDICTS),
      reason: z.string().describe('One sentence naming the line or behavior that decides it'),
    }),
  ),
});

/** Score each verdict contributes to a comment's agreement. */
const VERDICT_SCORE: Record<VerifyVerdict, number> = { upheld: 1, uncertain: 0.5, refuted: 0 };

export interface VerifyCall {
  requestedModel: string;
  servedModel: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  costUsd: number | null;
  latencyMs: number;
  cached: boolean;
}

export interface VerifyRequest {
  /** The same title, description and context the reviewer saw. */
  title: string;
  description: string;
  context: string;
  comments: readonly ModelComment[];
  model: string;
  fallbackModels: readonly string[];
  effort: Effort;
  promptVersion: string;
  passes: number;
  maxOutputTokens: number;
  cacheSalt?: string | undefined;
}

export interface VerifyResult {
  promptVersion: string;
  promptHash: string;
  /**
   * Per comment, in request order: the mean verdict score over passes (upheld 1, uncertain
   * 0.5, refuted 0). A pass that gave no verdict for a comment counts as uncertain.
   */
  agreement: number[];
  /** Per comment and pass, the verdict with its reason. */
  verdicts: { verdict: VerifyVerdict; reason: string }[][];
  calls: VerifyCall[];
}

function renderComments(comments: readonly ModelComment[]): string {
  return comments
    .map((c, id) =>
      [
        `<comment id="${id}">`,
        `file: ${c.file}`,
        `line: ${c.line}`,
        `category: ${c.category}`,
        `severity: ${c.severity}`,
        `claim: ${c.claim}`,
        `evidence: ${c.evidence}`,
        '</comment>',
      ].join('\n'),
    )
    .join('\n');
}

/**
 * A second model pass that tries to refute each candidate comment (spec §6, step 4). All
 * comments of a review are checked in one call per pass, so the cost is one extra call per
 * pass, not one per comment. Each pass has its own cache salt, so passes are independent
 * samples while a rerun of the same review is served from the cache.
 */
export async function verifyComments(
  llm: LLMClient,
  request: VerifyRequest,
): Promise<VerifyResult> {
  const prompt = await loadPrompt(request.promptVersion);
  const user = renderTemplate(prompt.user, {
    title: request.title,
    description: request.description,
    context: request.context,
    comments: renderComments(request.comments),
  });
  const n = request.comments.length;
  const scores: number[][] = Array.from({ length: n }, () => []);
  const verdicts: { verdict: VerifyVerdict; reason: string }[][] = Array.from(
    { length: n },
    () => [],
  );
  const calls: VerifyCall[] = [];
  for (let pass = 0; pass < request.passes; pass++) {
    const result = await llm.generate({
      model: request.model,
      fallbackModels: request.fallbackModels,
      effort: request.effort,
      system: prompt.system,
      prompt: user,
      schema: verifyOutputSchema,
      schemaName: VERIFY_SCHEMA_NAME,
      maxOutputTokens: request.maxOutputTokens,
      cacheSalt: `${request.cacheSalt ?? ''}|verify-${pass}`,
    });
    calls.push({
      requestedModel: result.requestedModel,
      servedModel: result.servedModel,
      usage: result.usage,
      costUsd: result.costUsd,
      latencyMs: result.latencyMs,
      cached: result.cached,
    });
    const seen = new Set<number>();
    for (const v of result.output.verdicts) {
      // Ignore ids that do not exist and repeated verdicts for one comment.
      if (v.id < 0 || v.id >= n || seen.has(v.id)) continue;
      seen.add(v.id);
      scores[v.id]!.push(VERDICT_SCORE[v.verdict]);
      verdicts[v.id]!.push({ verdict: v.verdict, reason: v.reason });
    }
    for (let id = 0; id < n; id++) {
      if (!seen.has(id)) {
        scores[id]!.push(VERDICT_SCORE.uncertain);
        verdicts[id]!.push({ verdict: 'uncertain', reason: '(no verdict returned)' });
      }
    }
  }
  return {
    promptVersion: prompt.version,
    promptHash: prompt.contentHash,
    agreement: scores.map((s) => s.reduce((a, b) => a + b, 0) / Math.max(s.length, 1)),
    verdicts,
    calls,
  };
}

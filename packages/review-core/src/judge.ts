import type { Effort, LLMClient } from '@reviewlens/llm';
import { z } from 'zod';
import { loadPrompt, renderTemplate } from './prompts.js';
import { scrubSecrets } from './scrub.js';

export const JUDGE_VERDICTS = ['valid', 'nitpick', 'invalid'] as const;
export type JudgeVerdict = (typeof JUDGE_VERDICTS)[number];

export const JUDGE_SCHEMA_NAME = 'judge-verdict/v1';
export const judgeOutputSchema = z.object({
  verdict: z.enum(JUDGE_VERDICTS),
  reason: z.string(),
});

export interface JudgeItem {
  /** Caller's identifier for the comment; echoed back. */
  id: string;
  path: string;
  /** Diff of the commented file, in any readable unified form. */
  diff: string;
  line: number;
  category: string;
  severity: string;
  claim: string;
  evidence: string;
  suggested_fix: string | null;
}

export interface JudgeConfig {
  model: string;
  fallbackModels?: readonly string[];
  effort?: Effort;
  promptVersion?: string;
  cacheSalt?: string;
}

export interface JudgeResult {
  id: string;
  verdict: JudgeVerdict;
  reason: string;
  promptVersion: string;
  promptHash: string;
  requestedModel: string;
  servedModel: string;
  cached: boolean;
}

/**
 * LLM judge for comment validity, used to estimate precision and noise at scale. It is a
 * measuring instrument, not ground truth: its agreement with human labels has to be
 * measured (the harness's `calibrate` command) before its numbers are reported.
 *
 * The judge sees only the commented file's diff and the comment, never the later fix, so
 * it cannot score a comment as valid merely because it matches the known bug.
 */
export async function judgeComment(
  item: JudgeItem,
  config: JudgeConfig,
  llm: LLMClient,
): Promise<JudgeResult> {
  const prompt = await loadPrompt(config.promptVersion ?? 'judge/v1');
  const scrub = (text: string) => scrubSecrets(text).text;
  const user = renderTemplate(prompt.user, {
    path: item.path,
    diff: scrub(item.diff),
    line: String(item.line),
    category: item.category,
    severity: item.severity,
    claim: scrub(item.claim),
    evidence: scrub(item.evidence),
    suggested_fix: scrub(item.suggested_fix ?? '(none)'),
  });
  const result = await llm.generate({
    model: config.model,
    fallbackModels: config.fallbackModels,
    effort: config.effort ?? 'low',
    system: prompt.system,
    prompt: user,
    schema: judgeOutputSchema,
    schemaName: JUDGE_SCHEMA_NAME,
    maxOutputTokens: 4_000,
    cacheSalt: config.cacheSalt,
  });
  return {
    id: item.id,
    verdict: result.output.verdict,
    reason: result.output.reason,
    promptVersion: prompt.version,
    promptHash: prompt.contentHash,
    requestedModel: result.requestedModel,
    servedModel: result.servedModel,
    cached: result.cached,
  };
}

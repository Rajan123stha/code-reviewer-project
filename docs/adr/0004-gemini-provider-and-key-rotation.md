# ADR 0004: Gemini as the default provider, with API key rotation

- Status: accepted
- Date: 2026-10-01
- Amends: ADR 0003 (default model, refusal fallback, cost)

## Context

The project owner wants to run on free Gemini API keys rather than paid Claude access, and
to keep reviews working when one key reaches its rate limit by moving to another key.

## Decisions

1. **The provider is part of `StrategyConfig`** (`provider: gemini | anthropic`), so it is
   hashed and stored with every review like the model is. `runReview` refuses to run when the
   config's provider differs from the client's, so a review can never be attributed to the
   wrong provider.
2. **Default model is `gemini-flash-latest`**, an alias that follows Google's current Flash
   model. Each call records the concrete version that answered (`modelVersion`, stored as
   `servedModel`). Experiments that must not drift should pin a concrete model with
   `REVIEW_MODEL` / `--model`.
3. **Structured output**: `responseMimeType: application/json` plus `responseJsonSchema`
   generated from the same zod schema used for Claude. `$schema` and zod's ±2^53 integer bounds
   are stripped. The response is validated with zod; a mismatch is a retryable `invalid_output`.
4. **Effort mapping**: `thinkingLevel` LOW/MEDIUM/HIGH on Gemini 3.x and later, and
   `thinkingBudget` (1k/4k/16k/dynamic) on 2.5 models. Thinking tokens are recorded as output
   tokens.
5. **Key pool** (`ApiKeyPool`):
   - Calls rotate round-robin across healthy keys.
   - On a 429 the key cools down for the server's `RetryInfo` delay (60 s if none). For a
     daily quota (`quotaId` containing `PerDay`) it cools down until the next midnight Pacific
     time, when Gemini quotas reset. The same request is then sent immediately on the next key.
   - A key the API rejects (invalid, blocked, 401/403) is disabled until the process restarts.
   - When no key is usable, the provider throws `rate_limit` with `retryAfterMs` set to the
     soonest cooldown end. `LLMClient` sleeps through waits up to `maxRetryAfterMs` (5 min) and
     surfaces anything longer at once. For example, when every key has used up its daily quota,
     the job fails instead of hanging for hours.
   - Keys appear in logs only as `key#N`.
6. **SDK retries are off** (`retryOptions.attempts: 1`); `LLMClient` keeps sole ownership of
   retries, as with Anthropic.
7. **Cost**: `GEMINI_FREE_TIER=true` (the default) records cost as 0. There is no Gemini price
   table yet; with paid keys the cost is recorded as null (unknown) until one is added.
8. **Refusal fallback** is off for Gemini presets. It is an Anthropic-only feature.
   `finishReason` SAFETY, RECITATION, BLOCKLIST, PROHIBITED_CONTENT and SPII, and a prompt
   `blockReason`, all map to a non-retryable `refusal`.

## Caveats the owner should weigh

- **Data use on the free tier.** Google's terms for the unpaid Gemini API tier allow Google to
  use prompts and responses to improve its products. Reviews send source code from installed
  repositories. Only install the app on repositories whose owners accept that, or use paid
  keys.
- **Quota scope.** Gemini rate limits apply per Google Cloud project, not per key. Several keys
  from one project share a quota, so rotating between them gains nothing. Rotation helps only
  across keys from different projects.
- **Terms of service.** Google's API terms prohibit circumventing rate limits. Rotation as
  failover between legitimately separate projects is common practice. Creating many projects
  to multiply the free quota is the case those terms target. That is the owner's call; the
  code does not encourage it.
- **Eval comparability.** Results from Gemini and Claude are separate experiment arms (E6),
  not interchangeable. `gemini-flash-latest` can change under you, so pin a model for headline
  runs.

## Amendment (2026-10-03): pinned default and model fallback

The first real calls showed that Google's newest models are often overloaded on the free tier
(`gemini-3.8-flash` and the `gemini-flash-latest` alias returned 503 on every attempt), while
`gemini-3.5-flash` answered in 10 s.

- The default model is now pinned to `gemini-3.8-flash` instead of the alias.
- `StrategyConfig.fallbackModels` (default `["gemini-3.5-flash"]`) lists models to try, in
  order, when a model is overloaded (5xx), unavailable to the account, or every key is out of
  quota for it. A bad request or a refusal does not fall back.
- Key cooldowns are tracked per model, because free-tier quotas are counted per model.
- The model that answered is stored as `servedModel` with `fallbackUsed: true`. The fallback
  list is part of the config hash and the LLM cache key.
- For experiments that must be served by one model, set `fallbackModels` to `[]`
  (`REVIEW_FALLBACK_MODELS=` or `--fallback-models ""`), or filter runs on `fallbackUsed`.

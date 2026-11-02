import { logEnv, redisEnv, secretString } from '@reviewlens/shared';
import { z } from 'zod';

/** The API's configuration, validated at startup before any port is opened. */
export const apiEnvSchema = z.object({
  ...redisEnv,
  ...logEnv,
  /** Verifies X-Hub-Signature-256 on every webhook; must match the GitHub App's setting. */
  GITHUB_WEBHOOK_SECRET: secretString(16),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Proxies whose X-Forwarded-For to trust, for per-client rate limits (e.g. "loopback"). */
  TRUST_PROXY: z
    .string()
    .regex(/^[A-Za-z0-9.:/,s-]{1,200}$/, 'must be addresses or CIDRs such as loopback')
    .optional(),
  /** Webhook requests per client per minute; failed signatures allowed per 10 minutes. */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().max(100_000).default(600),
  SIGNATURE_FAILURES_PER_10_MIN: z.coerce.number().int().positive().max(10_000).default(20),
});

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
});

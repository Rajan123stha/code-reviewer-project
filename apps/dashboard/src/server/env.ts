import { logEnv, postgresUrl, secretString } from '@reviewlens/shared';
import { z } from 'zod';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The dashboard's configuration, validated at startup before it opens a port. */
export const dashboardEnvSchema = z
  .object({
    ...logEnv,
    DATABASE_URL: postgresUrl,
    DASHBOARD_HOST: z.string().default('127.0.0.1'),
    DASHBOARD_PORT: z.coerce.number().int().default(4000),
    /** Required unless the dashboard listens on loopback only. */
    DASHBOARD_PASSWORD: secretString(12).optional(),
    RESULTS_DIR: z.string().optional(),
  })
  // Review data includes code from the reviewed repositories: never expose it unauthenticated.
  .superRefine((env, ctx) => {
    if (!LOOPBACK.has(env.DASHBOARD_HOST) && !env.DASHBOARD_PASSWORD) {
      ctx.addIssue({
        code: 'custom',
        path: ['DASHBOARD_PASSWORD'],
        message: 'is required when DASHBOARD_HOST is not a loopback address',
      });
    }
  });

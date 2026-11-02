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
    /** Extra host names the dashboard answers to, comma-separated (e.g. reviews.example.com). */
    DASHBOARD_ALLOWED_HOSTS: z
      .string()
      .regex(/^[A-Za-z0-9.:[\],\s-]{1,1000}$/, 'must be host names separated by commas')
      .optional(),
    /** Proxies whose X-Forwarded-For to trust (e.g. "loopback" behind a local reverse proxy). */
    TRUST_PROXY: z
      .string()
      .regex(/^[A-Za-z0-9.:/,\s-]{1,200}$/, 'must be addresses or CIDRs such as loopback')
      .optional(),
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

/** Host header values to accept: loopback on the port, plus any configured names. */
export function allowedHosts(port: number, extra?: string): string[] {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  const configured = (extra ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  // A configured name is accepted with and without an explicit port (behind a proxy on 443).
  return [
    ...names.map((n) => `${n}:${port}`),
    ...configured,
    ...configured.map((h) => `${h}:${port}`),
  ];
}

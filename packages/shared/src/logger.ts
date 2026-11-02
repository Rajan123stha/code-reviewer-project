import { trace } from '@opentelemetry/api';
import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import { redactSecrets, redactValue, REDACTED, SECRET_FIELDS } from './redact.js';

export type { Logger } from 'pino';

/**
 * Structured JSON logger. Every line carries the service name and, when a span
 * is active, its trace_id/span_id so logs can be joined with traces.
 *
 * Secrets never reach the output: known secret fields are censored at any depth, and
 * every string (messages, error messages and stacks included) is passed through
 * `redactSecrets`, which removes API keys, tokens, private keys and URL passwords.
 */
export function createLogger(
  service: string,
  options: LoggerOptions = {},
  /** Where to write; stdout by default. Tests pass a stream to inspect the output. */
  destination?: DestinationStream,
): Logger {
  const config: LoggerOptions = {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-hub-signature"]',
        'req.headers["x-hub-signature-256"]',
        'req.headers["x-goog-api-key"]',
        'req.headers["x-api-key"]',
        ...SECRET_FIELDS.flatMap((f) => [f, `*.${f}`]),
      ],
      censor: REDACTED,
    },
    serializers: {
      err: (err: Error) =>
        redactValue(stdSerializers.err(err)) as ReturnType<typeof stdSerializers.err>,
    },
    hooks: {
      // The message string and any extra string arguments.
      logMethod(args, method) {
        method.apply(
          this,
          args.map((a) => (typeof a === 'string' ? redactSecrets(a) : a)) as Parameters<
            typeof method
          >,
        );
      },
    },
    formatters: {
      // Strings anywhere in the merged object, after field redaction.
      log: (object) => redactValue(object) as Record<string, unknown>,
    },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const { traceId, spanId } = span.spanContext();
      return { trace_id: traceId, span_id: spanId };
    },
    ...options,
  };
  return destination ? pino(config, destination) : pino(config);
}

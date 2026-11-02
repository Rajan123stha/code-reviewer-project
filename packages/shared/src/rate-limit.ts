/**
 * Fixed-window rate limiting, keyed by client (usually its IP address).
 *
 * `hit` counts an event and says whether it is still within the limit; `blocked` only looks.
 * The second form backs "failure" limits (bad signatures, wrong passwords): every failure is
 * counted, and while a client is over the limit even its correct attempts are refused, so
 * guessing does not pay.
 */
export interface LimitResult {
  allowed: boolean;
  /** Events left in the current window (0 when blocked). */
  remaining: number;
  /** Milliseconds until the window resets. */
  resetMs: number;
}

export interface RateLimiter {
  hit(key: string): Promise<LimitResult>;
  blocked(key: string): Promise<LimitResult>;
}

export interface WindowLimit {
  max: number;
  windowMs: number;
}

/**
 * In-process limiter. Correct for one process; behind several processes use the Redis one.
 * The key table is bounded so a flood of distinct addresses cannot exhaust memory: when it
 * is full, expired windows are dropped first, then the oldest.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: WindowLimit,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  private window(key: string, create: boolean) {
    const now = this.now();
    let w = this.windows.get(key);
    if (w && w.resetAt <= now) {
      this.windows.delete(key);
      w = undefined;
    }
    if (!w && create) {
      if (this.windows.size >= this.maxKeys) this.evict(now);
      w = { count: 0, resetAt: now + this.limit.windowMs };
      this.windows.set(key, w);
    }
    return { w, now };
  }

  private evict(now: number) {
    for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest === undefined) break;
      this.windows.delete(oldest);
    }
  }

  async hit(key: string): Promise<LimitResult> {
    const { w, now } = this.window(key, true);
    w!.count++;
    return this.result(w!.count, w!.resetAt - now);
  }

  async blocked(key: string): Promise<LimitResult> {
    const { w, now } = this.window(key, false);
    // "Blocked" once the limit is used up: max failures are allowed, the next attempt is not.
    if (!w) return { allowed: true, remaining: this.limit.max, resetMs: 0 };
    return { ...this.result(w.count + 1, w.resetAt - now) };
  }

  private result(count: number, resetMs: number): LimitResult {
    return {
      allowed: count <= this.limit.max,
      remaining: Math.max(0, this.limit.max - count),
      resetMs,
    };
  }
}

/** The subset of an ioredis client the Redis limiter needs. */
export interface RedisCounter {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

/** Limiter shared by every process that uses the same Redis (one counter per key and window). */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RedisCounter,
    private readonly limit: WindowLimit,
    private readonly prefix: string,
  ) {}

  async hit(key: string): Promise<LimitResult> {
    const k = `${this.prefix}:${key}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, this.limit.windowMs);
    let ttl = await this.redis.pttl(k);
    // A key without expiry (a crash between INCR and PEXPIRE) would block forever: repair it.
    if (ttl < 0) {
      await this.redis.pexpire(k, this.limit.windowMs);
      ttl = this.limit.windowMs;
    }
    return {
      allowed: count <= this.limit.max,
      remaining: Math.max(0, this.limit.max - count),
      resetMs: ttl,
    };
  }

  async blocked(key: string): Promise<LimitResult> {
    const k = `${this.prefix}:${key}`;
    const count = Number((await this.redis.get(k)) ?? 0);
    const ttl = count ? Math.max(0, await this.redis.pttl(k)) : 0;
    return {
      allowed: count < this.limit.max,
      remaining: Math.max(0, this.limit.max - count),
      resetMs: ttl,
    };
  }
}

/** Seconds for a Retry-After header, at least 1. */
export function retryAfterSeconds(result: LimitResult): string {
  return String(Math.max(1, Math.ceil(result.resetMs / 1000)));
}

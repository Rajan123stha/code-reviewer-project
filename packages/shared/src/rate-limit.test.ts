import { describe, expect, it } from 'vitest';
import {
  MemoryRateLimiter,
  RedisRateLimiter,
  retryAfterSeconds,
  type RedisCounter,
} from './rate-limit.js';

describe('MemoryRateLimiter', () => {
  it('allows max hits per window, then refuses until the window resets', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter({ max: 2, windowMs: 1000 }, () => now);
    expect((await limiter.hit('a')).allowed).toBe(true);
    expect((await limiter.hit('a')).allowed).toBe(true);
    const third = await limiter.hit('a');
    expect(third).toEqual({ allowed: false, remaining: 0, resetMs: 1000 });
    expect(retryAfterSeconds(third)).toBe('1');
    // Other clients are counted separately.
    expect((await limiter.hit('b')).allowed).toBe(true);
    now = 1000;
    expect((await limiter.hit('a')).allowed).toBe(true);
  });

  it('blocks only after max failures, without counting the check itself', async () => {
    const limiter = new MemoryRateLimiter({ max: 2, windowMs: 1000 }, () => 0);
    expect((await limiter.blocked('a')).allowed).toBe(true);
    await limiter.hit('a');
    expect((await limiter.blocked('a')).allowed).toBe(true);
    await limiter.hit('a');
    expect((await limiter.blocked('a')).allowed).toBe(false);
    expect((await limiter.blocked('a')).allowed).toBe(false);
  });

  it('keeps memory bounded under a flood of distinct clients', async () => {
    const limiter = new MemoryRateLimiter({ max: 1, windowMs: 60_000 }, () => 0, 100);
    for (let i = 0; i < 10_000; i++) await limiter.hit(`10.0.${i >> 8}.${i & 255}`);
    expect(
      (limiter as unknown as { windows: Map<string, unknown> }).windows.size,
    ).toBeLessThanOrEqual(100);
  });
});

class FakeRedis implements RedisCounter {
  values = new Map<string, number>();
  ttl = new Map<string, number>();
  async incr(key: string) {
    const v = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, v);
    return v;
  }
  async pexpire(key: string, ms: number) {
    this.ttl.set(key, ms);
    return 1;
  }
  async pttl(key: string) {
    return this.ttl.get(key) ?? -1;
  }
  async get(key: string) {
    const v = this.values.get(key);
    return v === undefined ? null : String(v);
  }
}

describe('RedisRateLimiter', () => {
  it('counts in Redis with an expiry, shared by every process', async () => {
    const redis = new FakeRedis();
    const a = new RedisRateLimiter(redis, { max: 2, windowMs: 5000 }, 'rl');
    const b = new RedisRateLimiter(redis, { max: 2, windowMs: 5000 }, 'rl');
    expect((await a.hit('ip')).allowed).toBe(true);
    expect((await b.hit('ip')).allowed).toBe(true);
    expect((await a.hit('ip')).allowed).toBe(false);
    expect(redis.ttl.get('rl:ip')).toBe(5000);
    expect((await b.blocked('ip')).allowed).toBe(false);
  });

  it('repairs a counter that lost its expiry, so nobody is blocked forever', async () => {
    const redis = new FakeRedis();
    redis.values.set('rl:ip', 7);
    const limiter = new RedisRateLimiter(redis, { max: 100, windowMs: 5000 }, 'rl');
    await limiter.hit('ip');
    expect(redis.ttl.get('rl:ip')).toBe(5000);
  });
});

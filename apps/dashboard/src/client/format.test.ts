import { describe, expect, it } from 'vitest';
import { count, duration, humanize, percent, ratio, relativeTime, usd } from './format.js';
import { labelIndices, niceTicks } from './scale.js';

describe('format', () => {
  it('formats counts, shares and money', () => {
    expect(count(1284)).toBe('1,284');
    expect(count(12_900)).toBe('12.9K');
    expect(percent(0.4567)).toBe('46%');
    expect(percent(0.4567, 1)).toBe('45.7%');
    expect(percent(null)).toBe('—');
    expect(percent(Number.NaN)).toBe('—');
    expect(ratio(1, 4)).toBe('25%');
    expect(ratio(1, 0)).toBe('—');
    expect(usd(0)).toBe('$0');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(1.5)).toBe('$1.50');
    expect(usd(null)).toBe('—');
  });

  it('formats durations and relative times', () => {
    expect(duration(850)).toBe('850 ms');
    expect(duration(4_200)).toBe('4.2 s');
    expect(duration(35_400)).toBe('35 s');
    expect(duration(185_000)).toBe('3 min 5 s');
    const now = Date.parse('2026-10-15T12:00:00Z');
    expect(relativeTime('2026-10-15T11:59:30Z', now)).toBe('just now');
    expect(relativeTime('2026-10-15T11:55:00Z', now)).toBe('5 min ago');
    expect(relativeTime('2026-10-15T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeTime('2026-10-13T12:00:00Z', now)).toBe('2 d ago');
    expect(relativeTime(null, now)).toBe('—');
  });

  it('turns identifiers into words', () => {
    expect(humanize('resolved_with_change')).toBe('Resolved with change');
    expect(humanize('error-handling')).toBe('Error handling');
    expect(humanize('api-misuse')).toBe('API misuse');
  });
});

describe('scale', () => {
  it('picks round ticks that cover the maximum', () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(10)).toEqual([0, 5, 10]);
    expect(niceTicks(0.43)).toEqual([0, 0.2, 0.4, 0.6]);
    expect(niceTicks(1)).toEqual([0, 0.5, 1]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
  });

  it('spaces axis labels evenly and keeps both ends', () => {
    expect(labelIndices(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(labelIndices(30, 6)).toEqual([0, 6, 12, 18, 24, 29]);
    expect(labelIndices(31, 6)).toEqual([0, 6, 12, 18, 24, 30]);
  });
});

describe('GitHub links', () => {
  it('encodes each path segment, so a file name cannot add a query or fragment', async () => {
    const { githubBlobUrl, githubPullUrl } = await import('./format.js');
    expect(githubBlobUrl('octo/shop', 'a'.repeat(40), 'src/cart.ts', 8)).toBe(
      `https://github.com/octo/shop/blob/${'a'.repeat(40)}/src/cart.ts#L8`,
    );
    expect(githubBlobUrl('octo/shop', 'abc', 'src/a?x=1#L1 b.ts', 5)).toBe(
      'https://github.com/octo/shop/blob/abc/src/a%3Fx%3D1%23L1%20b.ts#L5',
    );
    expect(githubPullUrl('octo/shop', 12)).toBe('https://github.com/octo/shop/pull/12');
  });

  it('gives no link for a repository name that is not owner/name', async () => {
    const { githubBlobUrl, githubPullUrl } = await import('./format.js');
    expect(githubPullUrl('javascript:alert(1)//x', 1)).toBeNull();
    expect(githubPullUrl('octo/../../evil', 1)).toBeNull();
    expect(githubBlobUrl('a/b/c', 's', 'f', 1)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { rotate } from './factory.js';

describe('rotate', () => {
  it('starts the key list at an offset and wraps around', () => {
    expect(rotate(['a', 'b', 'c'], 0)).toEqual(['a', 'b', 'c']);
    expect(rotate(['a', 'b', 'c'], 1)).toEqual(['b', 'c', 'a']);
    expect(rotate(['a', 'b', 'c'], 4)).toEqual(['b', 'c', 'a']);
    expect(rotate([], 2)).toEqual([]);
  });
});

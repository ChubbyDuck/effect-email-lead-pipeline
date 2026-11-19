import { describe, expect, it } from 'vitest';

import { duration } from './format';

describe('duration', () => {
  it('shows milliseconds below one second', () => {
    expect(duration(0)).toBe('0 ms');
    expect(duration(850.5)).toBe('850.5 ms');
  });

  it('shows seconds from one second to below one minute', () => {
    expect(duration(1000)).toBe('1 s');
    expect(duration(59_999)).toBe('59.999 s');
  });

  it('shows minutes and seconds from one minute', () => {
    expect(duration(60_000)).toBe('1 min');
    expect(duration(571_365)).toBe('9 min 31.365 s');
    expect(duration(59_999.6)).toBe('1 min');
  });
});

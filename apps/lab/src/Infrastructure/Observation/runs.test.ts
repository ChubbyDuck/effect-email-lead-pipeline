import { describe, expect, test } from 'vitest';

import { filterPatternsOf } from './runs';

const runID = (index: number) => `20b3ae96-eb9e-5c4b-ab2f-${String(index).padStart(12, '0')}`;

describe('the filter patterns of a search', () => {
  test('match one term as a phrase', () => {
    expect(filterPatternsOf(['aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381'])).toEqual([
      '"aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381"',
    ]);
  });

  test('match any of many terms', () => {
    expect(filterPatternsOf(['ERROR', 'Task timed out'])).toEqual(['?"ERROR" ?"Task timed out"']);
  });

  test('split the IDs of 50 runs into patterns of at most 1024 characters', () => {
    const ids = Array.from({ length: 50 }, (_, index) => runID(index));

    const patterns = filterPatternsOf(ids);

    expect(patterns.map((pattern) => pattern.split(' ').length)).toEqual([25, 25]);
    expect(patterns.every((pattern) => pattern.length <= 1024)).toBe(true);
    expect(patterns.join(' ')).toBe(ids.map((id) => `?"${id}"`).join(' '));
  });

  test('need no pattern for no term', () => {
    expect(filterPatternsOf([])).toEqual([]);
  });

  test('refuse a term with a quote, which would end the phrase', () => {
    expect(() => filterPatternsOf(['a" ?"b'])).toThrow('A search term cannot have a quote');
  });
});

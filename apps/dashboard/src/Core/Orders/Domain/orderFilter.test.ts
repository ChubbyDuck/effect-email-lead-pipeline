import { expect, test } from 'vitest';

import { isFiltered, toOrderFilter } from './orderFilter';

test.each([
  [{}, { q: '', type: 'all' }],
  [
    { q: 'Bern', type: 'mutation' },
    { q: 'Bern', type: 'mutation' },
  ],
  [{ q: 3000 }, { q: '3000', type: 'all' }],
  [{ type: 'all' }, { q: '', type: 'all' }],
  [{ type: 'business_closure' }, { q: '', type: 'business_closure' }],
  [
    { q: ['Bern'], type: 'other' },
    { q: '', type: 'all' },
  ],
  [
    { q: true, type: 1 },
    { q: '', type: 'all' },
  ],
  [{ q: '   ' }, { q: '', type: 'all' }],
  [{ q: ' Bern ' }, { q: ' Bern ', type: 'all' }],
])('reads the filter %j as %j', (input, filter) => {
  expect(toOrderFilter(input)).toEqual(filter);
});

test.each([
  [{ q: '', type: 'all' }, false],
  [{ q: '  ', type: 'all' }, false],
  [{ q: 'Bern', type: 'all' }, true],
  [{ q: '', type: 'mutation' }, true],
] as const)('says that the filter %j narrows the orders: %s', (filter, filtered) => {
  expect(isFiltered(filter)).toBe(filtered);
});

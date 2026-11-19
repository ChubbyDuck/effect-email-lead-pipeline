import { expect, test } from 'vitest';

import { nextOrderSort, toOrderSort } from './orderSort';

test.each([
  [{}, { sort: 'storedAt', dir: 'desc' }],
  [
    { sort: 'name', dir: 'desc' },
    { sort: 'name', dir: 'desc' },
  ],
  [{ sort: 'city' }, { sort: 'city', dir: 'asc' }],
  [{ sort: 'storedAt' }, { sort: 'storedAt', dir: 'desc' }],
  [
    { sort: 'phone', dir: 'asc' },
    { sort: 'storedAt', dir: 'desc' },
  ],
  [{ dir: 'asc' }, { sort: 'storedAt', dir: 'desc' }],
  [
    { sort: 'zip', dir: 'up' },
    { sort: 'zip', dir: 'asc' },
  ],
  [
    { sort: 42, dir: ['desc'] },
    { sort: 'storedAt', dir: 'desc' },
  ],
])('reads the sort %j as %j', (input, sort) => {
  expect(toOrderSort(input)).toEqual(sort);
});

test.each([
  [{ sort: 'storedAt', dir: 'desc' }, 'name', { sort: 'name', dir: 'asc' }],
  [{ sort: 'name', dir: 'asc' }, 'name', { sort: 'name', dir: 'desc' }],
  [{ sort: 'name', dir: 'desc' }, 'name', { sort: 'name', dir: 'asc' }],
  [{ sort: 'name', dir: 'asc' }, 'storedAt', { sort: 'storedAt', dir: 'desc' }],
  [{ sort: 'storedAt', dir: 'desc' }, 'storedAt', { sort: 'storedAt', dir: 'asc' }],
] as const)('goes from the sort %j with a click on %s to %j', (current, key, next) => {
  expect(nextOrderSort(current, key)).toEqual(next);
});

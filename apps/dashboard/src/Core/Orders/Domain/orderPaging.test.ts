import { expect, test } from 'vitest';

import { toOrderPaging, toOrderPageSize } from './orderPaging';

test.each([
  [{}, { page: 1, size: 25 }],
  [
    { page: 3, size: 10 },
    { page: 3, size: 10 },
  ],
  [{ size: 50 }, { page: 1, size: 50 }],
  [{ page: 0 }, { page: 1, size: 25 }],
  [{ page: -2 }, { page: 1, size: 25 }],
  [{ page: 999 }, { page: 999, size: 25 }],
  [{ page: 2.5 }, { page: 1, size: 25 }],
  [{ page: '2' }, { page: 1, size: 25 }],
  [{ page: Number.NaN }, { page: 1, size: 25 }],
  [{ page: Number.POSITIVE_INFINITY }, { page: 1, size: 25 }],
  [{ size: 20 }, { page: 1, size: 25 }],
  [{ size: '10' }, { page: 1, size: 25 }],
])('reads the paging %j as %j', (input, paging) => {
  expect(toOrderPaging(input)).toEqual(paging);
});

test.each([
  [10, 10],
  [25, 25],
  [50, 50],
  [100, 25],
  [undefined, 25],
])('reads the page size %j as %i', (input, size) => {
  expect(toOrderPageSize(input)).toBe(size);
});

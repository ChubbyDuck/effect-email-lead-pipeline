import { expect, test } from 'vitest';

import { changeOrderQuery, defaultOrderQuery, toOrderQuery } from './orderQuery';

test('reads each part of the query from untrusted input, with a default for each value that is not valid', () => {
  expect(
    toOrderQuery({ q: 'Bern', type: 'mutation', sort: 'zip', dir: 'desc', page: 3, size: 50, order: 'abc123' })
  ).toStrictEqual({
    q: 'Bern',
    type: 'mutation',
    sort: 'zip',
    dir: 'desc',
    page: 3,
    size: 50,
    order: 'abc123',
  });
  expect(toOrderQuery({ q: ['x'], type: 'other', sort: 'phone', page: 'two', size: 7, order: 7 })).toStrictEqual(
    defaultOrderQuery
  );
});

test.each([undefined, '', '   ', 123, ['abc']])('gives no open order for the order key %j', (order) => {
  expect(toOrderQuery({ order }).order).toBeUndefined();
});

const onPage3 = { ...defaultOrderQuery, q: 'Bern', page: 3, size: 10 } as const;

test.each([
  ['q', { q: 'Thun' }],
  ['type', { type: 'mutation' }],
  ['sort', { sort: 'name', dir: 'asc' }],
  ['dir', { dir: 'asc' }],
  ['size', { size: 50 }],
  ['filters', { q: '', type: 'all' }],
] as const)('goes back to the first page on a change of the %s', (_, change) => {
  expect(changeOrderQuery(onPage3, change)).toEqual({ ...onPage3, ...change, page: 1 });
});

test('keeps the page when the change gives the same query', () => {
  expect(changeOrderQuery(onPage3, { q: 'Bern', size: 10 })).toEqual(onPage3);
});

test('keeps the page when a blank search text replaces no search text', () => {
  const query = { ...onPage3, q: '' };

  expect(changeOrderQuery(query, { q: '   ' })).toEqual(query);
});

test('goes to the page of a change of the page, and keeps the rest of the query', () => {
  expect(changeOrderQuery(onPage3, { page: 4 })).toEqual({ ...onPage3, page: 4 });
});

test('keeps the open order and the page when a person opens another order', () => {
  expect(changeOrderQuery({ ...onPage3, order: 'a' }, { order: 'b' })).toStrictEqual({ ...onPage3, order: 'b' });
});

test('keeps the open order when a filter changes', () => {
  expect(changeOrderQuery({ ...onPage3, order: 'a' }, { type: 'mutation' })).toStrictEqual({
    ...onPage3,
    type: 'mutation',
    page: 1,
    order: 'a',
  });
});

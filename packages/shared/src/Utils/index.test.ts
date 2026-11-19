import { expect, test } from 'vitest';

import { balance } from './index';

test('balance deals items round-robin into at most capacity batches', () => {
  expect(balance([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
    [1, 4, 7],
    [2, 5],
    [3, 6],
  ]);
  expect(balance([1, 2], 5)).toEqual([[1], [2]]);
  expect(balance([], 5)).toEqual([]);
});

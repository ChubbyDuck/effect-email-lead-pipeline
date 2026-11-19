/**
 * The order query: the filters, the sort, and the paging of the orders. It is apart from `order.ts`, which reads the
 * lead schemas, so that the browser can validate the URL with the same rules as the server.
 */
import { defaultOrderFilter, type OrderFilter, toOrderFilter } from './orderFilter';
import { defaultOrderPaging, type OrderPaging, toOrderPaging } from './orderPaging';
import { defaultOrderSort, type OrderSort, toOrderSort } from './orderSort';

/** The key of the order that the sheet shows, or `undefined` when the sheet is closed. */
export type OrderSelection = {
  readonly order: string | undefined;
};

/**
 * The input of the order page: which orders to show, how to sort them, which page of them to show, how many rows a
 * page has, and which order the sheet shows.
 */
export type OrderQuery = OrderFilter & OrderSort & OrderPaging & OrderSelection;

/** All the orders, newest first, on the first page of 25 rows, with the sheet closed. */
export const defaultOrderQuery: OrderQuery = {
  ...defaultOrderFilter,
  ...defaultOrderSort,
  ...defaultOrderPaging,
  order: undefined,
};

/**
 * Reads the key of an order from untrusted input. A key is a text, so a value that is not a text or that is blank gives
 * no order: a number would not be the same key.
 */
const toOrderKey = (input: unknown): string | undefined =>
  typeof input === 'string' && input.trim() !== '' ? input : undefined;

/** Reads an order query from untrusted input, such as the URL. Each value that is not valid falls back to its default. */
export const toOrderQuery = (input: Readonly<Record<string, unknown>>): OrderQuery => ({
  ...toOrderFilter(input),
  ...toOrderSort(input),
  ...toOrderPaging(input),
  order: toOrderKey(input['order']),
});

/** The parts of the query that choose the orders, their order, or the rows of a page. The open order is not one. */
const pageResetKeys = ['q', 'type', 'sort', 'dir', 'size'] as const satisfies readonly (keyof OrderQuery)[];

/**
 * The query after a person changes a part of it. A change of the filters, the sort, or the page size goes back to the
 * first page, so that the new orders do not land on an empty page. A change that gives the same query, such as a blank
 * search text in place of no search text, keeps the page.
 */
export const changeOrderQuery = (previous: OrderQuery, change: Partial<OrderQuery>): OrderQuery => {
  const next = toOrderQuery({ ...previous, ...change });
  return pageResetKeys.some((key) => next[key] !== previous[key]) ? { ...next, page: defaultOrderPaging.page } : next;
};

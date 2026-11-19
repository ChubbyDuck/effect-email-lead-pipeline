/**
 * The sort of the orders. It is apart from `order.ts`, which reads the lead schemas, so that the browser can validate
 * the URL without the code of the server.
 */

/** The columns that sort the orders. */
export const OrderSortKeys = ['storedAt', 'name', 'city', 'zip', 'type'] as const;

export type OrderSortKey = (typeof OrderSortKeys)[number];

export const SortDirections = ['asc', 'desc'] as const;

export type SortDirection = (typeof SortDirections)[number];

/** The sort of the orders: a column and a direction. */
export type OrderSort = {
  readonly sort: OrderSortKey;
  readonly dir: SortDirection;
};

/** The newest orders first. */
export const defaultOrderSort: OrderSort = { sort: 'storedAt', dir: 'desc' };

/** The direction of a column when a person first sorts by it: the newest orders first, and a text from A to Z. */
const firstDirectionOf = (sort: OrderSortKey): SortDirection => (sort === 'storedAt' ? 'desc' : 'asc');

/**
 * Reads a sort from untrusted input, such as the URL. A column that is absent or not valid gives the default sort, with
 * its direction. A direction that is absent or not valid gives the first direction of the column.
 */
export const toOrderSort = (input: { readonly sort?: unknown; readonly dir?: unknown }): OrderSort => {
  const sort = OrderSortKeys.find((key) => key === input.sort);
  if (sort === undefined) return defaultOrderSort;
  const dir = SortDirections.find((direction) => direction === input.dir) ?? firstDirectionOf(sort);
  return { sort, dir };
};

/** The sort after a person chooses a column: the same column reverses its direction, another column starts it. */
export const nextOrderSort = (current: OrderSort, sort: OrderSortKey): OrderSort => ({
  sort,
  dir: current.sort !== sort ? firstDirectionOf(sort) : current.dir === 'asc' ? 'desc' : 'asc',
});

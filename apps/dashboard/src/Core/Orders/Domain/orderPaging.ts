/**
 * The pages of the orders: which page to show, and how many rows a page has. They are apart from `order.ts`, which
 * reads the lead schemas, so that the browser can validate the URL without the code of the server.
 */

/** The choices of the rows on one page. */
export const OrderPageSizes = [10, 25, 50] as const;

export type OrderPageSize = (typeof OrderPageSizes)[number];

/** The page of the orders to show, from 1, and the rows on each page. */
export type OrderPaging = {
  readonly page: number;
  readonly size: OrderPageSize;
};

/** The first page of 25 rows. */
export const defaultOrderPaging: OrderPaging = { page: 1, size: 25 };

/** Reads a page size from untrusted input. A value that is not a page size gives the default size. */
export const toOrderPageSize = (input: unknown): OrderPageSize =>
  OrderPageSizes.find((size) => size === input) ?? defaultOrderPaging.size;

/**
 * Reads a page number from untrusted input. A number below 1 is 1, and a value that is not a whole number gives the
 * first page. The use case moves a page above the last page to the last page, because only the read knows the last
 * page.
 */
const toPageNumber = (input: unknown): number =>
  typeof input === 'number' && Number.isSafeInteger(input) ? Math.max(input, 1) : defaultOrderPaging.page;

/** Reads the paging from untrusted input, such as the URL. A value that is absent or not valid gives its default. */
export const toOrderPaging = (input: { readonly page?: unknown; readonly size?: unknown }): OrderPaging => ({
  page: toPageNumber(input.page),
  size: toOrderPageSize(input.size),
});

/** The count of the pages of `total` orders. An empty result has one page. */
export const pageCountOf = (total: number, size: OrderPageSize): number => Math.max(1, Math.ceil(total / size));

/** The page number inside the pages: a number below 1 is 1, and a number above the last page is the last page. */
export const pageWithin = (page: number, pages: number): number => Math.min(Math.max(page, 1), pages);

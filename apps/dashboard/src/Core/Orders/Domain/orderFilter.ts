/**
 * The filters of the orders: a search text and a source type. They are apart from `order.ts`, which reads the lead
 * schemas, so that the browser can validate the URL without the code of the server.
 */
import type { LeadSourceType } from '@leads/shared/domain/types';

/** Each source type once, in the order of the type select. The record makes the compiler find a missing type. */
const sourceTypes = {
  new_acquisition: true,
  business_closure: true,
  mutation: true,
} satisfies Record<LeadSourceType, true>;

export const OrderSourceTypes = Object.keys(sourceTypes) as readonly LeadSourceType[];

/** One source type, or all of them. */
export type OrderTypeFilter = LeadSourceType | 'all';

/** The filters of the orders. A blank `q` matches all the orders. */
export type OrderFilter = {
  readonly q: string;
  readonly type: OrderTypeFilter;
};

/** No filter: all the orders. */
export const defaultOrderFilter: OrderFilter = { q: '', type: 'all' };

/** Reads a source type from untrusted input. A value that is not a source type gives all the types. */
export const toOrderTypeFilter = (input: unknown): OrderTypeFilter =>
  OrderSourceTypes.find((type) => type === input) ?? defaultOrderFilter.type;

/** Reads a search text from untrusted input. The router reads a number from a URL such as `?q=3000`. */
const toSearchText = (input: unknown): string => {
  const text = typeof input === 'string' ? input : typeof input === 'number' ? String(input) : '';
  return text.trim() === '' ? defaultOrderFilter.q : text;
};

/** Reads the filters from untrusted input, such as the URL. A value that is absent, blank, or not valid gives its default. */
export const toOrderFilter = (input: { readonly q?: unknown; readonly type?: unknown }): OrderFilter => ({
  q: toSearchText(input.q),
  type: toOrderTypeFilter(input.type),
});

/** True when a filter narrows the orders. */
export const isFiltered = ({ q, type }: OrderFilter): boolean => q.trim() !== '' || type !== 'all';

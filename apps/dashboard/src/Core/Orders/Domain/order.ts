import { cellText } from '@leads/shared/domain/schemas';
import {
  LEAD_SOURCE_HEADER__BUSINESS_CLOSURE,
  LeadExtractedDataSchema_BusinessClosure,
} from '@leads/shared/domain/sources/BusinessClosure';
import { LEAD_SOURCE_HEADER__MUTATION, LeadExtractedDataSchema_Mutation } from '@leads/shared/domain/sources/Mutation';
import {
  LEAD_SOURCE_HEADER__NEW_ACQUISITION,
  LeadExtractedDataSchema_NewAcquisition,
} from '@leads/shared/domain/sources/NewAcquisition';
import { type Lead, type LeadSourceType, LeadSourceTypes } from '@leads/shared/domain/types';

import { type OrderPaging, pageCountOf, pageWithin } from './orderPaging';
import type { OrderQuery } from './orderQuery';
import type { OrderSort, OrderSortKey } from './orderSort';

/**
 * A lead that the lead handler stored in the Orders table. `storedAt` is the time of its first storage, as an ISO
 * string. An order that the handler stored before it wrote the time has none.
 */
export type Order = {
  readonly lead: Lead;
  readonly storedAt: string | undefined;
};

/** Every stored order, and the time of the read as an ISO string. */
export type OrderRead = {
  readonly orders: readonly Order[];
  readonly readAt: string;
};

/**
 * The flat view of an order for a table. It hides the differences between the source types: a field that the source
 * type of the order lacks is `undefined`.
 */
export type OrderRow = {
  readonly key: string;
  readonly type: LeadSourceType;
  readonly storedAt: string | undefined;
  readonly name: string | undefined;
  readonly street: string | undefined;
  readonly zip: string | undefined;
  readonly city: string | undefined;
  readonly phone: string | undefined;
  readonly mobile: string | undefined;
  readonly email: string | undefined;
  readonly uid: string | undefined;
  readonly subjectNumber: string | undefined;
  readonly companyAdditional: string | undefined;
  readonly ownerName: string | undefined;
};

/** A field of a row that some source types lack. The name, the key, the type, and the time are in every row. */
export type OrderField = Exclude<keyof OrderRow, 'key' | 'type' | 'storedAt' | 'name'>;

/** One column of the workbook row of an order: its header, and its value as a text, or `undefined` when it is empty. */
export type OrderColumn = {
  readonly name: string;
  readonly value: string | undefined;
};

/**
 * All the data of one order. `fields` are the fields of the row that the source type of the order has, so that a field
 * without a value is not taken for a field that the type lacks. `columns` are all the columns of the workbook row, in
 * the order of the header of the source type.
 */
export type OrderDetail = {
  readonly row: OrderRow;
  readonly fields: readonly OrderField[];
  readonly columns: readonly OrderColumn[];
};

/** The order of the `order` key of the query, or the key when no stored order has it. */
export type SelectedOrder =
  | { readonly found: true; readonly detail: OrderDetail }
  | { readonly found: false; readonly key: string };

/**
 * One page of the orders that match the filters. `total` is the count of these orders, and `storedTotal` is the count
 * of all the stored orders. The count of each source type is the count after the search and before the type filter, so that each
 * choice of the type filter shows the count that it gives. `page` is the page that the rows are on, from 1 to `pages`:
 * a page of the query above the last page gives the last page. `selected` is the order of the `order` key of the query,
 * found in all the orders and not only in the orders that match the filters, or `undefined` when the query has no key.
 */
export type OrderPage = OrderPaging & {
  readonly rows: readonly OrderRow[];
  readonly pages: number;
  readonly total: number;
  readonly storedTotal: number;
  readonly counts: Readonly<Record<LeadSourceType, number>>;
  readonly selected: SelectedOrder | undefined;
  readonly readAt: string;
};

/** The fields of the extracted data that some source types lack. */
type ExtractedField = 'email' | 'uid' | 'subjectNumber' | 'companyAdditional' | 'ownerName' | 'mobile';

const fieldOf = (lead: Lead, field: ExtractedField): string | undefined =>
  field in lead.extracted ? (lead.extracted as Partial<Record<ExtractedField, string>>)[field] : undefined;

export const toOrderRow = ({ lead, storedAt }: Order): OrderRow => ({
  key: lead.idempotencyKey,
  type: lead.extraction_source,
  storedAt,
  name: lead.extracted.name,
  street: lead.extracted.street,
  zip: lead.extracted.zip,
  city: lead.extracted.city,
  phone: lead.extracted.phone,
  mobile: fieldOf(lead, 'mobile'),
  email: fieldOf(lead, 'email'),
  uid: fieldOf(lead, 'uid'),
  subjectNumber: fieldOf(lead, 'subjectNumber'),
  companyAdditional: fieldOf(lead, 'companyAdditional'),
  ownerName: fieldOf(lead, 'ownerName'),
});

/** Each field that a source type can lack. */
const orderFields = [
  'ownerName',
  'street',
  'zip',
  'city',
  'phone',
  'mobile',
  'email',
  'uid',
  'subjectNumber',
  'companyAdditional',
] as const satisfies readonly OrderField[];

/** The fields that a source type has, from the schema of its extracted data. */
const fieldsOf = (schema: { readonly fields: object }): readonly OrderField[] =>
  orderFields.filter((field) => field in schema.fields);

/** The fields of the row and the header of the workbook of each source type. */
const sourceTypeDetails: Record<
  LeadSourceType,
  { readonly fields: readonly OrderField[]; readonly header: readonly string[] }
> = {
  new_acquisition: {
    fields: fieldsOf(LeadExtractedDataSchema_NewAcquisition),
    header: LEAD_SOURCE_HEADER__NEW_ACQUISITION,
  },
  business_closure: {
    fields: fieldsOf(LeadExtractedDataSchema_BusinessClosure),
    header: LEAD_SOURCE_HEADER__BUSINESS_CLOSURE,
  },
  mutation: { fields: fieldsOf(LeadExtractedDataSchema_Mutation), header: LEAD_SOURCE_HEADER__MUTATION },
};

const toOrderDetail = (order: Order): OrderDetail => {
  const { fields, header } = sourceTypeDetails[order.lead.extraction_source];
  const raw: Readonly<Record<string, unknown>> = order.lead.raw;
  return {
    row: toOrderRow(order),
    fields,
    // An empty text is no value, as an empty cell.
    columns: header.map((name) => ({ name, value: cellText(raw[name]) || undefined })),
  };
};

/** The order of the key in all the orders, or the key when no order has it. */
const selectedOf = (orders: readonly Order[], key: string): SelectedOrder => {
  const order = orders.find(({ lead }) => lead.idempotencyKey === key);
  return order === undefined ? { found: false, key } : { found: true, detail: toOrderDetail(order) };
};

/** Compares the text of a column as a person reads it: without the case, and with the numbers in their numeric order. */
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** The value of a column, or `undefined` when the order has none. An empty text is no value, as in the table. */
const valueOf = (row: OrderRow, sort: OrderSortKey): string | undefined => (row[sort] === '' ? undefined : row[sort]);

/**
 * Sorts by the column of the sort in its direction. An order without a value in the column goes to the end, in both
 * directions. A tie breaks on the key, so the same orders always give the same pages.
 */
const bySort =
  ({ sort, dir }: OrderSort) =>
  (a: OrderRow, b: OrderRow): number => {
    const left = valueOf(a, sort);
    const right = valueOf(b, sort);
    if (left !== right) {
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      const order = collator.compare(left, right);
      if (order !== 0) return dir === 'asc' ? order : -order;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };

/** The fields of a row that the search reads. */
const searchedFields = ['name', 'street', 'city', 'zip', 'phone', 'mobile', 'email', 'uid'] as const;

/** True when a part of a searched field is the text, without the case. A blank text matches all the orders. */
const bySearch = (q: string) => {
  const text = q.trim().toLowerCase();
  return (row: OrderRow): boolean =>
    text === '' || searchedFields.some((field) => row[field]?.toLowerCase().includes(text) === true);
};

const countsOf = (rows: readonly OrderRow[]): Record<LeadSourceType, number> => {
  const counts = Object.fromEntries(LeadSourceTypes.map((type) => [type, 0])) as Record<LeadSourceType, number>;
  for (const row of rows) counts[row.type] += 1;
  return counts;
};

/** The page of the query from all the orders of one read. */
export const orderPageOf = ({ orders, readAt }: OrderRead, query: OrderQuery): OrderPage => {
  const { type, size } = query;
  const found = orders.map(toOrderRow).filter(bySearch(query.q));
  const rows = (type === 'all' ? found : found.filter((row) => row.type === type)).toSorted(bySort(query));
  const pages = pageCountOf(rows.length, size);
  const page = pageWithin(query.page, pages);
  return {
    rows: rows.slice((page - 1) * size, page * size),
    page,
    pages,
    size,
    total: rows.length,
    storedTotal: orders.length,
    counts: countsOf(found),
    selected: query.order === undefined ? undefined : selectedOf(orders, query.order),
    readAt,
  };
};

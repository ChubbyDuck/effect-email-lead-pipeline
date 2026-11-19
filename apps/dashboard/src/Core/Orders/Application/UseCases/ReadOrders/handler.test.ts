import { Lead } from '@leads/shared/domain/types';
import { Effect, Schema } from 'effect';
import { expect, test } from 'vitest';

import type { Order } from '#Core/Orders/Domain/order';
import { defaultOrderQuery } from '#Core/Orders/Domain/orderQuery';
import { OrdersNotRead } from '#Core/Orders/Ports/OrderReader';
import {
  makeOrderReader,
  orderReaderBuilder,
  readFailure,
  sessionExpired,
} from '#Infrastructure/Orders/OrderReader/mock/variants';

import type { Command } from './command';
import { handler } from './handler';

const readAt = '2026-10-16T12:00:00.000Z';

/** The time of storage of the order with the number `n`: the higher the number, the newer the order. */
const storedAtOf = (n: number) => new Date(Date.parse('2026-10-01T00:00:00.000Z') + n * 60_000).toISOString();

const newAcquisition = (n: number, { stored = true } = {}): Order => ({
  lead: Schema.decodeSync(Lead)({
    extraction_source: 'new_acquisition',
    idempotencyKey: `new-${n}`,
    extracted: { name: `New ${n}`, city: 'Bern', zip: '3000', phone: '031 000 00 00', uid: `CHE-${n}` },
    raw: { Name: `New ${n}` },
  }),
  storedAt: stored ? storedAtOf(n) : undefined,
});

const businessClosure = (n: number): Order => ({
  lead: Schema.decodeSync(Lead)({
    extraction_source: 'business_closure',
    idempotencyKey: `closure-${n}`,
    extracted: { name: `Closure ${n}`, email: 'closure@example.ch', companyAdditional: 'AG' },
    raw: { Name: `Closure ${n}` },
  }),
  storedAt: storedAtOf(n),
});

const mutation = (n: number): Order => ({
  lead: Schema.decodeSync(Lead)({
    extraction_source: 'mutation',
    idempotencyKey: `mutation-${n}`,
    extracted: { name: `Mutation ${n}`, ownerName: 'Anna Muster', mobile: '079 000 00 00' },
    raw: { Zukünftiger_Betriebsname: `Mutation ${n}` },
  }),
  storedAt: storedAtOf(n),
});

function read(orders: readonly Order[], command?: Command) {
  const orderReader = makeOrderReader(orderReaderBuilder.all('succeeds'));
  orderReader.observation.holds({ orders, readAt });
  return Effect.runPromise(handler(command).pipe(Effect.provide(orderReader.layer)));
}

test('gives the newest 25 orders first on the default page, with the total of all the orders', async () => {
  const orders = Array.from({ length: 30 }, (_, n) => newAcquisition(n));

  const page = await read([...orders.slice(15), ...orders.slice(0, 15)]);

  expect(page.total).toBe(30);
  expect(page.readAt).toBe(readAt);
  expect(page.rows.map((row) => row.key)).toEqual(Array.from({ length: 25 }, (_, n) => `new-${29 - n}`));
});

test('counts the orders of each source type', async () => {
  const page = await read([newAcquisition(1), businessClosure(2), businessClosure(3), mutation(4)]);

  expect(page.total).toBe(4);
  expect(page.counts).toEqual({ new_acquisition: 1, business_closure: 2, mutation: 1 });
});

test('gives each source type as one flat row, with undefined for a field that the type lacks', async () => {
  const page = await read([newAcquisition(1), businessClosure(2), mutation(3)]);

  expect(page.rows).toEqual([
    {
      key: 'mutation-3',
      type: 'mutation',
      storedAt: storedAtOf(3),
      name: 'Mutation 3',
      street: undefined,
      zip: undefined,
      city: undefined,
      phone: undefined,
      mobile: '079 000 00 00',
      email: undefined,
      uid: undefined,
      subjectNumber: undefined,
      companyAdditional: undefined,
      ownerName: 'Anna Muster',
    },
    {
      key: 'closure-2',
      type: 'business_closure',
      storedAt: storedAtOf(2),
      name: 'Closure 2',
      street: undefined,
      zip: undefined,
      city: undefined,
      phone: undefined,
      mobile: undefined,
      email: 'closure@example.ch',
      uid: undefined,
      subjectNumber: undefined,
      companyAdditional: 'AG',
      ownerName: undefined,
    },
    {
      key: 'new-1',
      type: 'new_acquisition',
      storedAt: storedAtOf(1),
      name: 'New 1',
      street: undefined,
      zip: '3000',
      city: 'Bern',
      phone: '031 000 00 00',
      mobile: undefined,
      email: undefined,
      uid: 'CHE-1',
      subjectNumber: undefined,
      companyAdditional: undefined,
      ownerName: undefined,
    },
  ]);
});

test('puts an order without a time of storage after the orders with one', async () => {
  const page = await read([newAcquisition(1, { stored: false }), newAcquisition(2), newAcquisition(3)]);

  expect(page.rows.map((row) => [row.key, row.storedAt])).toEqual([
    ['new-3', storedAtOf(3)],
    ['new-2', storedAtOf(2)],
    ['new-1', undefined],
  ]);
});

/** A new acquisition with the key `key` and only the fields that a sort test needs. */
const newAcquisitionWith = (
  key: string,
  { name, city, zip, storedAt }: { name?: string; city?: string; zip?: string; storedAt?: string } = {}
): Order => ({
  lead: Schema.decodeSync(Lead)({
    extraction_source: 'new_acquisition',
    idempotencyKey: key,
    extracted: { name, city, zip },
    raw: {},
  }),
  storedAt,
});

const keysOf = (page: { readonly rows: readonly { readonly key: string }[] }) => page.rows.map((row) => row.key);

test.each([
  {
    sort: 'storedAt',
    orders: [
      newAcquisitionWith('a', { storedAt: storedAtOf(2) }),
      newAcquisitionWith('b', { storedAt: storedAtOf(1) }),
      newAcquisitionWith('c', { storedAt: storedAtOf(3) }),
    ],
    ascending: ['b', 'a', 'c'],
  },
  {
    sort: 'name',
    orders: [
      newAcquisitionWith('a', { name: 'Müller' }),
      newAcquisitionWith('b', { name: 'Aebi' }),
      newAcquisitionWith('c', { name: 'zingg' }),
    ],
    ascending: ['b', 'a', 'c'],
  },
  {
    sort: 'city',
    orders: [
      newAcquisitionWith('a', { city: 'Zürich' }),
      newAcquisitionWith('b', { city: 'bern' }),
      newAcquisitionWith('c', { city: 'Luzern' }),
    ],
    ascending: ['b', 'c', 'a'],
  },
  {
    sort: 'zip',
    orders: [
      newAcquisitionWith('a', { zip: '8001' }),
      newAcquisitionWith('b', { zip: '3000' }),
      newAcquisitionWith('c', { zip: '6003' }),
    ],
    ascending: ['b', 'c', 'a'],
  },
  {
    sort: 'type',
    orders: [newAcquisition(1), businessClosure(2), mutation(3)],
    ascending: ['closure-2', 'mutation-3', 'new-1'],
  },
] as const)('sorts the orders by $sort in both directions', async ({ sort, orders, ascending }) => {
  const asc = await read(orders, { ...defaultOrderQuery, sort, dir: 'asc' });
  const desc = await read(orders, { ...defaultOrderQuery, sort, dir: 'desc' });

  expect(keysOf(asc)).toEqual(ascending);
  expect(keysOf(desc)).toEqual(ascending.toReversed());
});

test.each(['asc', 'desc'] as const)(
  'puts the orders without a value at the end, also in the %s direction',
  async (dir) => {
    const page = await read(
      [
        newAcquisitionWith('a', { city: '' }),
        newAcquisitionWith('b', { city: 'Bern' }),
        newAcquisitionWith('c'),
        newAcquisitionWith('d', { city: 'Aarau' }),
      ],
      { ...defaultOrderQuery, sort: 'city', dir }
    );

    expect(keysOf(page)).toEqual(dir === 'asc' ? ['d', 'b', 'a', 'c'] : ['b', 'd', 'a', 'c']);
  }
);

test.each(['asc', 'desc'] as const)(
  'puts the orders without a time of storage at the end, also in the %s direction',
  async (dir) => {
    const page = await read(
      [
        newAcquisitionWith('a'),
        newAcquisitionWith('b', { storedAt: storedAtOf(2) }),
        newAcquisitionWith('c', { storedAt: storedAtOf(1) }),
      ],
      { ...defaultOrderQuery, sort: 'storedAt', dir }
    );

    expect(keysOf(page)).toEqual(dir === 'asc' ? ['c', 'b', 'a'] : ['b', 'c', 'a']);
  }
);

test.each(['asc', 'desc'] as const)('breaks a tie on the key of the order in the %s direction', async (dir) => {
  const page = await read(
    [
      newAcquisitionWith('c', { city: 'bern' }),
      newAcquisitionWith('a', { city: 'Bern' }),
      newAcquisitionWith('d', { city: 'Aarau' }),
      newAcquisitionWith('b', { city: 'Bern' }),
    ],
    { ...defaultOrderQuery, sort: 'city', dir }
  );

  expect(keysOf(page)).toEqual(dir === 'asc' ? ['d', 'a', 'b', 'c'] : ['a', 'b', 'c', 'd']);
});

test('keeps the tie break on the key from one page to the next', async () => {
  const orders = Array.from({ length: 30 }, (_, n) =>
    newAcquisitionWith(`key-${String(n).padStart(2, '0')}`, { zip: '3000' })
  );

  const first = await read(orders.toReversed(), { ...defaultOrderQuery, sort: 'zip', size: 10 });
  const second = await read(orders, { ...defaultOrderQuery, sort: 'zip', page: 2, size: 10 });

  expect(keysOf(first)).toEqual(orders.slice(0, 10).map((order) => order.lead.idempotencyKey));
  expect(keysOf(second)).toEqual(orders.slice(10, 20).map((order) => order.lead.idempotencyKey));
});

test.each([
  { variant: 'failsWithOrdersNotRead', reason: readFailure, authentication: false },
  { variant: 'failsWithOrdersNotReadForExpiredSession', reason: sessionExpired, authentication: true },
] as const)('fails with OrdersNotRead when the read $variant', async ({ variant, reason, authentication }) => {
  const orderReader = makeOrderReader(orderReaderBuilder.all(variant));

  const result = await Effect.runPromise(Effect.result(handler().pipe(Effect.provide(orderReader.layer))));

  expect(result._tag).toBe('Failure');
  if (result._tag !== 'Failure') return;
  expect(result.failure).toBeInstanceOf(OrdersNotRead);
  expect(result.failure.reason).toBe(reason);
  expect(result.failure.authentication).toBe(authentication);
});

/** One order of each source type with a value in each field that the search reads. */
const searchable = [
  {
    lead: Schema.decodeSync(Lead)({
      extraction_source: 'new_acquisition',
      idempotencyKey: 'new',
      extracted: {
        name: 'Bäckerei Aebi',
        street: 'Marktgasse 1',
        city: 'Thun',
        zip: '3600',
        phone: '033 111 11 11',
        uid: 'CHE-123.456.789',
      },
      raw: {},
    }),
    storedAt: storedAtOf(3),
  },
  {
    lead: Schema.decodeSync(Lead)({
      extraction_source: 'business_closure',
      idempotencyKey: 'closure',
      extracted: { name: 'Garage Kunz', email: 'info@kunz.example.ch', subjectNumber: 'S-77' },
      raw: {},
    }),
    storedAt: storedAtOf(2),
  },
  {
    lead: Schema.decodeSync(Lead)({
      extraction_source: 'mutation',
      idempotencyKey: 'mutation',
      extracted: { name: 'Café Rosa', mobile: '079 222 22 22', ownerName: 'Rosa Meier' },
      raw: {},
    }),
    storedAt: storedAtOf(1),
  },
] satisfies Order[];

test.each([
  { field: 'name', q: 'aebi', keys: ['new'] },
  { field: 'street', q: 'marktgasse', keys: ['new'] },
  { field: 'city', q: 'thun', keys: ['new'] },
  { field: 'zip', q: '360', keys: ['new'] },
  { field: 'phone', q: '111 11', keys: ['new'] },
  { field: 'mobile', q: '222 22', keys: ['mutation'] },
  { field: 'email', q: '@kunz.example.ch', keys: ['closure'] },
  { field: 'uid', q: '456.789', keys: ['new'] },
])('finds an order by a part of its $field', async ({ q, keys }) => {
  const page = await read(searchable, { ...defaultOrderQuery, q });

  expect(keysOf(page)).toEqual(keys);
  expect(page.total).toBe(keys.length);
});

test.each(['BÄCKEREI', 'bäckerei', 'BäCkErEi'])('ignores the case of the letters in the search %s', async (q) => {
  const page = await read(searchable, { ...defaultOrderQuery, q });

  expect(keysOf(page)).toEqual(['new']);
});

test.each(['', '   '])('gives all the orders for the blank search %j', async (q) => {
  const page = await read(searchable, { ...defaultOrderQuery, q });

  expect(keysOf(page)).toEqual(['new', 'closure', 'mutation']);
  expect(page.total).toBe(3);
});

test('does not find an order by a field that the search does not read', async () => {
  const page = await read(searchable, { ...defaultOrderQuery, q: 'Rosa Meier' });

  expect(keysOf(page)).toEqual([]);
  expect(page.total).toBe(0);
});

test.each([
  { type: 'new_acquisition', keys: ['new-4', 'new-1'] },
  { type: 'business_closure', keys: ['closure-3'] },
  { type: 'mutation', keys: ['mutation-2'] },
  { type: 'all', keys: ['new-4', 'closure-3', 'mutation-2', 'new-1'] },
] as const)('filters the orders by the source type $type', async ({ type, keys }) => {
  const page = await read([newAcquisition(1), mutation(2), businessClosure(3), newAcquisition(4)], {
    ...defaultOrderQuery,
    type,
  });

  expect(keysOf(page)).toEqual(keys);
  expect(page.total).toBe(keys.length);
  expect(page.storedTotal).toBe(4);
});

test('gives only the orders that match both the search and the source type', async () => {
  const orders = [newAcquisition(1), newAcquisition(2), newAcquisition(12), businessClosure(2), mutation(3)];

  const page = await read(orders, { ...defaultOrderQuery, q: '2', type: 'new_acquisition' });

  expect(keysOf(page)).toEqual(['new-12', 'new-2']);
  expect(page.total).toBe(2);
  expect(page.storedTotal).toBe(5);
});

test('counts each source type after the search and before the type filter', async () => {
  const orders = [
    newAcquisition(1),
    newAcquisition(2),
    newAcquisition(12),
    businessClosure(2),
    businessClosure(3),
    mutation(3),
  ];

  const page = await read(orders, { ...defaultOrderQuery, q: '2', type: 'mutation' });

  expect(keysOf(page)).toEqual([]);
  expect(page.counts).toEqual({ new_acquisition: 2, business_closure: 1, mutation: 0 });
});

/** The orders with the numbers 0 to `count - 1`, newest last, so that the default sort gives the highest number first. */
const ordersOf = (count: number) => Array.from({ length: count }, (_, n) => newAcquisition(n));

test.each([
  { size: 10, pages: 12, first: 'new-109', last: 'new-100' },
  { size: 25, pages: 5, first: 'new-94', last: 'new-70' },
  { size: 50, pages: 3, first: 'new-69', last: 'new-20' },
] as const)('gives the second page of $size rows', async ({ size, pages, first, last }) => {
  const page = await read(ordersOf(120), { ...defaultOrderQuery, page: 2, size });

  expect(page.rows).toHaveLength(size);
  expect([page.rows[0]?.key, page.rows.at(-1)?.key]).toEqual([first, last]);
  expect(page).toMatchObject({ page: 2, size, pages, total: 120 });
});

test('gives the newest orders on the first page', async () => {
  const page = await read(ordersOf(23), { ...defaultOrderQuery, page: 1, size: 10 });

  expect(keysOf(page)).toEqual(Array.from({ length: 10 }, (_, n) => `new-${22 - n}`));
  expect(page).toMatchObject({ page: 1, pages: 3, total: 23 });
});

test('gives the rest of the orders on the last page', async () => {
  const page = await read(ordersOf(23), { ...defaultOrderQuery, page: 3, size: 10 });

  expect(keysOf(page)).toEqual(['new-2', 'new-1', 'new-0']);
  expect(page).toMatchObject({ page: 3, pages: 3, total: 23 });
});

test.each([0, -4])('gives the first page for the page number %i', async (number) => {
  const page = await read(ordersOf(23), { ...defaultOrderQuery, page: number, size: 10 });

  expect(page.rows[0]?.key).toBe('new-22');
  expect(page).toMatchObject({ page: 1, pages: 3 });
});

test.each([4, 99])('gives the last page for the page number %i, which is above the last page', async (number) => {
  const page = await read(ordersOf(23), { ...defaultOrderQuery, page: number, size: 10 });

  expect(keysOf(page)).toEqual(['new-2', 'new-1', 'new-0']);
  expect(page).toMatchObject({ page: 3, pages: 3 });
});

test('gives the last page of the filtered orders when a filter makes fewer pages', async () => {
  const page = await read([...ordersOf(23), businessClosure(30)], {
    ...defaultOrderQuery,
    type: 'business_closure',
    page: 3,
    size: 10,
  });

  expect(keysOf(page)).toEqual(['closure-30']);
  expect(page).toMatchObject({ page: 1, pages: 1, total: 1 });
});

test('gives one empty page when no order matches', async () => {
  const page = await read(ordersOf(23), { ...defaultOrderQuery, q: 'nothing', page: 2 });

  expect(page).toMatchObject({ rows: [], page: 1, pages: 1, total: 0 });
});

test('gives one empty page when no order is stored', async () => {
  const page = await read([], { ...defaultOrderQuery, page: 5 });

  expect(page).toMatchObject({ rows: [], page: 1, pages: 1, total: 0, storedTotal: 0 });
});

test('gives no selected order when the query has no order key', async () => {
  const page = await read([newAcquisition(1), mutation(2)]);

  expect(page.selected).toBeUndefined();
});

test('finds the selected order in all the orders, also when the filters and the page hide it', async () => {
  const page = await read([...ordersOf(30), mutation(40)], {
    ...defaultOrderQuery,
    q: 'Mutation',
    type: 'mutation',
    order: 'new-3',
  });

  expect(keysOf(page)).toEqual(['mutation-40']);
  expect(page.selected).toMatchObject({ found: true, detail: { row: { key: 'new-3', name: 'New 3' } } });
});

test('says that the selected order is not found when no stored order has its key', async () => {
  const page = await read(ordersOf(3), { ...defaultOrderQuery, order: 'unknown-key' });

  expect(page.selected).toEqual({ found: false, key: 'unknown-key' });
  expect(keysOf(page)).toEqual(['new-2', 'new-1', 'new-0']);
});

/** One order of each source type with a value in each column of its workbook row. */
const detailed = {
  new_acquisition: {
    raw: {
      UIDNr: 'CHE-1',
      SubNr: 'S-1',
      Name: 'Bäckerei Aebi',
      Zusatzname: 'AG',
      AdrZusatz: 'Hinterhaus',
      Strasse: 'Marktgasse 1',
      Plz: '3600',
      Ort: 'Thun',
      Kt: 'BE',
      PrimTel: '033 111 11 11',
      KontTel: '079 111 11 11',
      TelP: '',
      TelG: '033 111 11 12',
      MobileP: '',
      MobileG: '',
      Bemerkung: 'Bitte anrufen',
    },
    fields: ['street', 'zip', 'city', 'phone', 'mobile', 'uid', 'subjectNumber', 'companyAdditional'],
  },
  business_closure: {
    raw: {
      UIDNr: 'CHE-2',
      SubNr: 'S-2',
      AbrNr: 'A-2',
      Name: 'Garage Kunz',
      Zusatzname: '',
      AdrZusatz: '',
      Strasse: 'Bahnhofstrasse 2',
      Plz: '8001',
      Ort: 'Zürich',
      Kt: 'ZH',
      PrimTel: '044 222 22 22',
      KontTel: '',
      TelP: '',
      TelG: '',
      MobileP: '',
      'E-Mail': 'info@kunz.example.ch',
      Pakete: 'Basis',
      'Gültig ab': '2026-01-01',
      Bemerkung: '',
    },
    fields: ['street', 'zip', 'city', 'phone', 'mobile', 'email', 'uid', 'subjectNumber', 'companyAdditional'],
  },
  mutation: {
    raw: {
      Kanton: 'LU',
      Gegenwärtiger_Betriebsname: 'Rössli',
      Gegenwärtiger_Wirtename: 'Hans Meier',
      Strasse_Nr: 'Seestrasse 3',
      Postfach: '',
      PLZ: '6003',
      Ort: 'Luzern',
      Telefon: '041 333 33 33',
      www: 'roessli.example.ch',
      'E-Mail': 'info@roessli.example.ch',
      Mutationsgrund: 'Wirtewechsel',
      Mutationsdatum: '2026-02-01',
      Zukünftiger_Betriebsname: 'Café Rosa',
      Rechtsform: 'GmbH',
      Zukünftiger_Wirtename: 'Rosa Meier',
      Anzahl_Gästezimmer: '0',
      Sitzplätze_Innen: '40',
      Sitzplätze_Aussen: '20',
      Erreichbarkeit_Name: 'Rosa Meier',
      Erreichbarkeit_Strasse: 'Seestrasse 3',
      Erreichbarkeit_PLZ_Ort: '6003 Luzern',
      Erreichbarkeit_Tel: '079 333 33 33',
    },
    fields: ['ownerName', 'street', 'zip', 'city', 'phone', 'mobile', 'email'],
  },
} as const;

test.each(Object.entries(detailed))(
  'gives the fields of the source type %s and the columns of its workbook row in their original order',
  async (type, { raw, fields }) => {
    const order: Order = {
      lead: Schema.decodeUnknownSync(Lead)({
        extraction_source: type,
        idempotencyKey: 'detailed',
        extracted: { name: 'Detailed' },
        // A stored item gives the columns in no fixed order.
        raw: Object.fromEntries(Object.entries(raw).toReversed()),
      }),
      storedAt: storedAtOf(1),
    };

    const page = await read([order], { ...defaultOrderQuery, order: 'detailed' });

    expect(page.selected).toEqual({
      found: true,
      detail: {
        row: page.rows[0],
        fields,
        // An empty cell has no value.
        columns: Object.entries(raw).map(([name, value]) => ({ name, value: value === '' ? undefined : value })),
      },
    });
  }
);

test('gives a column without a value in the workbook row as no value', async () => {
  const order: Order = {
    lead: Schema.decodeSync(Lead)({
      extraction_source: 'new_acquisition',
      idempotencyKey: 'sparse',
      extracted: {},
      raw: { Name: 'Sparse', Plz: 3600 },
    }),
    storedAt: undefined,
  };

  const page = await read([order], { ...defaultOrderQuery, order: 'sparse' });

  const columns = page.selected?.found === true ? page.selected.detail.columns : [];
  expect(columns.slice(0, 4)).toEqual([
    { name: 'UIDNr', value: undefined },
    { name: 'SubNr', value: undefined },
    { name: 'Name', value: 'Sparse' },
    { name: 'Zusatzname', value: undefined },
  ]);
  expect(columns.find((column) => column.name === 'Plz')).toEqual({ name: 'Plz', value: '3600' });
});

test('gives a date in the workbook row as its ISO date, and an object as no value', async () => {
  const order: Order = {
    lead: Schema.decodeSync(Lead)({
      extraction_source: 'new_acquisition',
      idempotencyKey: 'objects',
      extracted: {},
      raw: { Name: { richText: [{ text: 'Bold' }] }, Bemerkung: new Date(2026, 9, 1) },
    }),
    storedAt: undefined,
  };

  const page = await read([order], { ...defaultOrderQuery, order: 'objects' });

  const columns = page.selected?.found === true ? page.selected.detail.columns : [];
  expect(columns.find((column) => column.name === 'Name')).toEqual({ name: 'Name', value: undefined });
  expect(columns.find((column) => column.name === 'Bemerkung')).toEqual({ name: 'Bemerkung', value: '2026-10-01' });
});

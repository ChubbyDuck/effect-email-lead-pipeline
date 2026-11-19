import { toIdempotencyKey } from '@leads/shared/domain/schemas';
import { LEAD_SOURCE_HEADER__BUSINESS_CLOSURE } from '@leads/shared/domain/sources/BusinessClosure';
import { LEAD_SOURCE_HEADER__MUTATION } from '@leads/shared/domain/sources/Mutation';
import { LEAD_SOURCE_HEADER__NEW_ACQUISITION } from '@leads/shared/domain/sources/NewAcquisition';
import { Effect } from 'effect';
import { expect, test } from 'vitest';

import { UnknownLeadsSource } from '#Core/Pipeline/Domain/Exceptions/UnknownLeadsSource';
import { toLeadsAndRejectionsFromSheet } from '#Core/Pipeline/Domain/Transformations/leadSources';

test('toLeadsAndRejectionsFromSheet extracts new acquisition leads and rejects empty rows', async () => {
  const { leads, leadRejections } = await Effect.runPromise(
    toLeadsAndRejectionsFromSheet({
      header: LEAD_SOURCE_HEADER__NEW_ACQUISITION,
      rows: [
        { Name: ' Acme ', Zusatzname: 'Holding', AdrZusatz: 'c/o Beta', Plz: 8000, Ort: 'Zürich', UIDNr: 'CHE-1' },
        { Name: 'K.A.', Ort: '.' },
      ],
    })
  );

  expect(leads).toEqual([
    {
      extraction_source: 'new_acquisition',
      idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
      raw: { Name: 'Acme', Zusatzname: 'Holding', AdrZusatz: 'c/o Beta', Plz: '8000', Ort: 'Zürich', UIDNr: 'CHE-1' },
      extracted: {
        name: 'Acme',
        companyAdditional: 'Holding c/o Beta',
        street: undefined,
        zip: '8000',
        city: 'Zürich',
        phone: undefined,
        mobile: undefined,
        uid: 'CHE-1',
        subjectNumber: undefined,
      },
    },
  ]);
  expect(leadRejections).toHaveLength(1);
  expect(leadRejections[0]).toMatchObject({ index: 1, input: { Name: 'K.A.', Ort: '.' } });
  expect(leadRejections[0]?.error.message).toMatch(/Row is empty/);
});

test('toLeadsAndRejectionsFromSheet extracts business closure leads with ISO dates in raw', async () => {
  const { leads } = await Effect.runPromise(
    toLeadsAndRejectionsFromSheet({
      header: LEAD_SOURCE_HEADER__BUSINESS_CLOSURE,
      rows: [{ Name: 'Beta', 'E-Mail': 'beta@example.ch', 'Gültig ab': new Date(2024, 0, 15) }],
    })
  );

  expect(leads[0]).toMatchObject({
    extraction_source: 'business_closure',
    idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    raw: { Name: 'Beta', 'E-Mail': 'beta@example.ch', 'Gültig ab': '2024-01-15' },
    extracted: { name: 'Beta', email: 'beta@example.ch', companyAdditional: undefined },
  });
});

test('toLeadsAndRejectionsFromSheet extracts mutation leads from future business columns', async () => {
  const { leads } = await Effect.runPromise(
    toLeadsAndRejectionsFromSheet({
      header: LEAD_SOURCE_HEADER__MUTATION,
      rows: [{ Gegenwärtiger_Betriebsname: 'Old', Zukünftiger_Betriebsname: 'New', Zukünftiger_Wirtename: 'Ada' }],
    })
  );

  expect(leads[0]).toMatchObject({
    extraction_source: 'mutation',
    idempotencyKey: expect.stringMatching(/^[0-9a-f]{64}$/),
    extracted: { name: 'New', ownerName: 'Ada' },
  });
});

test('toLeadsAndRejectionsFromSheet fails with UnknownLeadsSource when the header matches no source exactly', async () => {
  const reordered = [...LEAD_SOURCE_HEADER__NEW_ACQUISITION].reverse();
  const truncated = LEAD_SOURCE_HEADER__MUTATION.slice(1);

  for (const header of [reordered, truncated, []]) {
    const error = await Effect.runPromise(
      toLeadsAndRejectionsFromSheet({ header, rows: [{ Name: 'Acme' }] }).pipe(Effect.flip)
    );

    expect(error).toBeInstanceOf(UnknownLeadsSource);
    expect(error).toMatchObject({ header, message: 'Unknown leads source' });
  }
});

test('toLeadsAndRejectionsFromSheet gives the same row the same idempotency key and a changed row a new one', async () => {
  const { leads } = await Effect.runPromise(
    toLeadsAndRejectionsFromSheet({
      header: LEAD_SOURCE_HEADER__NEW_ACQUISITION,
      rows: [
        { Name: 'Acme', Ort: 'Zürich' },
        { Ort: ' Zürich ', Name: 'Acme', Plz: 'K.A.' },
        { Name: 'Acme', Ort: 'Bern' },
      ],
    })
  );
  const [first, same, changed] = leads.map((lead) => lead.idempotencyKey);

  expect(first).toBe(toIdempotencyKey('new_acquisition', { Name: 'Acme', Ort: 'Zürich' }));
  expect(same).toBe(first);
  expect(changed).not.toBe(first);
  expect(toIdempotencyKey('business_closure', { Name: 'Acme', Ort: 'Zürich' })).not.toBe(first);
});

test('toIdempotencyKey hashes a date cell as its local ISO date', () => {
  expect(toIdempotencyKey('business_closure', { 'Gültig ab': new Date(2024, 0, 15) })).toBe(
    toIdempotencyKey('business_closure', { 'Gültig ab': '2024-01-15' })
  );
});

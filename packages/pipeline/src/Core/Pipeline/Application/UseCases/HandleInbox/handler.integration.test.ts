import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { requestFolderOf, requestIDOfEmail, sourceKey } from '@leads/shared/domain/keys';
import type { LeadData_BusinessClosure } from '@leads/shared/domain/sources/BusinessClosure';
import type { LeadData_Mutation } from '@leads/shared/domain/sources/Mutation';
import type { LeadData_NewAcquisition } from '@leads/shared/domain/sources/NewAcquisition';
import { File } from '@leads/shared/domain/types';
import { makeRequestLedger, requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { Cause, ConfigProvider, Effect, Exit, Layer, Logger } from 'effect';
import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { read, utils, write } from 'xlsx';

import { email, type Attachment } from '#Core/Pipeline/Application/UseCases/testing/email';
import { makeEmailParserLive } from '#Infrastructure/Pipeline/EmailParser/live';
import { GuardLive } from '#Infrastructure/Pipeline/Guard/live';
import { makeStorageLive } from '#Infrastructure/Pipeline/Storage/live';

import { handler } from './handler';

const s3 = new S3Client({
  endpoint: process.env.FLOCI_ENDPOINT ?? 'http://127.0.0.1:4566',
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
});

const suffix = randomUUID();
const buckets = {
  inbox: `leads-inbox-${suffix}`,
  sources: `leads-sources-${suffix}`,
};
const storedAt = '27-09-2026/14-30';
const owner = 'Owner <owner@example.com>';
const instant = new Date(2026, 8, 27, 14, 37);
/** The test keys are not SES message IDs, so each email is the request with a hash of its location. */
const requestIDOf = (key: string) => requestIDOfEmail(File.make({ bucket: buckets.inbox, key }));

function workbook<T extends Record<string, unknown>>(rows: readonly T[]): Buffer {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.json_to_sheet([...rows]), 'Leads');
  return Buffer.from(write(book, { type: 'buffer', bookType: 'xlsx' }));
}

// Stable examples shaped like the original Swiss lead generators. Fixed values make S3 byte assertions reproducible.
const attachments: readonly Attachment[] = [
  {
    filename: 'Business Closure.xlsx',
    content: workbook<LeadData_BusinessClosure>([
      {
        UIDNr: 'CHE-123.456.789',
        SubNr: '1234567',
        AbrNr: '123.4567.89',
        Name: 'Alpenblick Hotel AG',
        Zusatzname: 'Mara Keller',
        AdrZusatz: 'Alpenblick Hotel AG',
        Strasse: 'Bahnhofstrasse 12',
        Plz: 8001,
        Ort: 'Zürich',
        Kt: 'ZH',
        PrimTel: '+41 44 123 45 67',
        KontTel: '+41 79 123 45 67',
        TelP: 'K.A',
        TelG: '+41 44 123 45 67',
        MobileP: '+41 79 123 45 67',
        'E-Mail': 'mara.keller@example.ch',
        Pakete: 'PK 10 M, PK 10 F',
        'Gültig ab': '01-10-2026',
        Bemerkung: 'Betrieb wird Ende September geschlossen.',
      },
    ]),
  },
  {
    filename: 'New Acquisition.xlsx',
    content: workbook<LeadData_NewAcquisition>([
      {
        UIDNr: 'CHE-987.654.321',
        SubNr: '7654321',
        Name: 'Seeblick Gastronomie GmbH',
        Zusatzname: 'Lena Meier',
        AdrZusatz: 'Seeblick Gastronomie GmbH',
        Strasse: 'Seestrasse 4',
        Plz: 6003,
        Ort: 'Luzern',
        Kt: 'LU',
        PrimTel: '+41 41 222 33 44',
        KontTel: '+41 78 222 33 44',
        TelP: 'K.A',
        TelG: '+41 41 222 33 44',
        MobileP: '+41 78 222 33 44',
        MobileG: 'K.A',
        Bemerkung: 'Neuer Betrieb am See.',
      },
    ]),
  },
  {
    filename: 'Mutation.xlsx',
    content: workbook<LeadData_Mutation>([
      {
        Kanton: 'BE',
        Gegenwärtiger_Betriebsname: 'Altstadt Café',
        Gegenwärtiger_Wirtename: 'Jonas Frei',
        Strasse_Nr: 'Marktgasse 8',
        Postfach: '',
        PLZ: 3011,
        Ort: 'Bern',
        Telefon: '+41 31 555 12 12',
        www: 'https://example.ch',
        'E-Mail': 'jonas.frei@example.ch',
        Mutationsgrund: 'Wirtewechsel',
        Mutationsdatum: '27/09/26',
        Zukünftiger_Betriebsname: 'Altstadt Bistro',
        Rechtsform: 'GmbH',
        Zukünftiger_Wirtename: 'Nina Baumann',
        Anzahl_Gästezimmer: 0,
        Sitzplätze_Innen: 36,
        Sitzplätze_Aussen: 18,
        Erreichbarkeit_Name: 'Nina Baumann',
        Erreichbarkeit_Strasse: 'Marktgasse 8',
        Erreichbarkeit_PLZ_Ort: '3011 Bern',
        Erreichbarkeit_Tel: '+41 79 555 12 12',
      },
    ]),
  },
];

async function put(bucket: string, key: string, body: Buffer) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

async function get(bucket: string, key: string): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return Buffer.from(await response.Body!.transformToByteArray());
}

async function absent(bucket: string, key: string) {
  await expect(s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).rejects.toMatchObject({
    $metadata: { httpStatusCode: 404 },
  });
}

async function keys(bucket: string): Promise<string[]> {
  const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
  return (response.Contents ?? []).flatMap((item) => (item.Key === undefined ? [] : [item.Key]));
}

function run(key: string, sourcesBucket = buckets.sources) {
  const logged: unknown[] = [];
  const storage = makeStorageLive(s3);
  const configProvider = ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      LEAD_SOURCES_BUCKET_NAME: sourcesBucket,
      LEAD_PROCESSING_RETRY: 3,
      LEAD_PROCESSING_TIMEOUT: 45_000,
      INBOX_INTERNAL_CONCURRENCY: 3,
      INBOX_SENDER_WHITELIST: ['owner@example.com'],
    })
  );
  const services = Layer.mergeAll(
    storage,
    makeEmailParserLive(simpleParser),
    GuardLive,
    // Floci has no request ledger table yet, so the handler acknowledges its request and records progress in a mock.
    makeRequestLedger(requestLedgerBuilder.acknowledge('succeeds').record('succeeds')).layer,
    Logger.layer([
      Logger.make((options) => {
        if (options.logLevel === 'Error') {
          logged.push(...(Array.isArray(options.message) ? options.message : [options.message]));
        }
      }),
    ])
  ).pipe(Layer.provideMerge(configProvider));
  return Effect.runPromise(
    Effect.exit(handler({ bucket: buckets.inbox, key, receivedAt: instant, functionName: 'inboxHandler' })).pipe(
      Effect.provide(services)
    )
  ).then((exit) => ({ logged, exit }));
}

function expectFailure(exit: Exit.Exit<unknown, unknown>, error: unknown) {
  const fails = Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error) : [];
  expect(fails).toMatchObject([error]);
}

beforeAll(async () => {
  for (const bucket of Object.values(buckets)) await s3.send(new CreateBucketCommand({ Bucket: bucket }));
});

afterAll(async () => {
  try {
    for (const bucket of Object.values(buckets)) {
      for (const key of await keys(bucket)) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
  } finally {
    s3.destroy();
  }
});

test('stores three real workbook attachments and deletes an authorized email', async () => {
  const key = 'received/September leads + Zürich.eml';
  const requestID = requestIDOf(key);
  const body = email('Owner <owner@example.com>', attachments);
  await put(buckets.inbox, key, body);

  const { logged, exit } = await run(key);
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toEqual([]);

  await absent(buckets.inbox, key);
  for (const [index, file] of attachments.entries()) {
    const slug = file.filename.replace('.xlsx', '').toLowerCase().replaceAll(' ', '-');
    const saved = await get(buckets.sources, `${storedAt}/${requestID}/0${index + 1}-${slug}`);
    expect(saved).toEqual(file.content);
    const book = read(saved, { type: 'buffer' });
    expect(utils.sheet_to_json(book.Sheets['Leads']!)).toHaveLength(1);
  }
});

test('logs an external sender and deletes the inbox object', async () => {
  const key = 'received/external.eml';
  const requestID = requestIDOf(key);
  const body = email('Outside Contact <outside@example.org>', [
    { filename: 'External.xlsx', content: attachments[0]!.content },
  ]);
  await put(buckets.inbox, key, body);

  const { logged, exit } = await run(key);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toHaveLength(1);
  expect(logged[0]).toMatchObject({ _tag: 'Unauthorized' });
  await absent(buckets.inbox, key);
  await absent(
    buckets.sources,
    sourceKey({ ...requestFolderOf(instant, requestID), index: 0, filename: 'External.xlsx' })
  );
});

test.each([
  {
    name: 'an email that SES did not authenticate',
    key: 'received/unauthenticated.eml',
    body: () => email(owner, [attachments[0]!], { authenticated: false }),
    reason: 'Email is not authenticated by SES',
  },
  {
    name: 'an email with a second From header that hides the real sender',
    key: 'received/two-from-headers.eml',
    body: () => email(owner, [attachments[0]!], { headers: ['From: Outside Contact <outside@example.org>'] }),
    reason: 'Email has more than one From header',
  },
])('logs $name as unauthorized and deletes the inbox object', async ({ key, body, reason }) => {
  const requestID = requestIDOf(key);
  await put(buckets.inbox, key, body());

  const { logged, exit } = await run(key);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toMatchObject([{ _tag: 'Unauthorized', reason }]);
  await absent(buckets.inbox, key);
  expect((await keys(buckets.sources)).filter((item) => item.includes(requestID))).toEqual([]);
});

test('accepts an authorized email without attachments and deletes it', async () => {
  const key = 'received/no-attachments.eml';
  const body = email('Owner <owner@example.com>');
  await put(buckets.inbox, key, body);

  const { logged, exit } = await run(key);
  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toEqual([]);
  await absent(buckets.inbox, key);
});

test('fails the inbox event and leaves the email in place when its attachment cannot be stored', async () => {
  const key = 'received/store-failure.eml';
  const body = email('Owner <owner@example.com>', [attachments[0]!]);
  await put(buckets.inbox, key, body);

  const { logged, exit } = await run(key, `missing-sources-${suffix}`);

  const failure = {
    _tag: 'InboxEventNotHandled',
    reason: { _tag: 'AttachmentsNotStored', failures: [{ _tag: 'FileNotStored' }] },
  };
  expect(logged).toMatchObject([failure]);
  expectFailure(exit, failure);
  expect(await get(buckets.inbox, key)).toEqual(body);
});

test('logs an empty inbox object as not parsed and deletes it', async () => {
  const key = 'received/empty.eml';
  await put(buckets.inbox, key, Buffer.alloc(0));

  const { logged, exit } = await run(key);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toMatchObject([{ _tag: 'EmailNotParsed', reason: { _tag: 'File is empty', service: 'EmailParser' } }]);
  await absent(buckets.inbox, key);
});

test('fails the inbox event when the inbox object is missing', async () => {
  const key = 'received/missing.eml';

  const { logged, exit } = await run(key);

  const failure = { _tag: 'InboxEventNotHandled', reason: { _tag: 'FileNotRead', bucket: buckets.inbox, key } };
  expect(logged).toMatchObject([failure]);
  expectFailure(exit, failure);
  await absent(buckets.inbox, key);
});

test('keeps an attachment that an earlier run stored and stores the rest on a redelivery', async () => {
  const key = 'received/redelivery.eml';
  const requestID = requestIDOf(key);
  const body = email('Owner <owner@example.com>', attachments.slice(0, 2));
  const earlier = Buffer.from('stored by the first run');
  await put(buckets.inbox, key, body);
  await put(buckets.sources, `${storedAt}/${requestID}/01-business-closure`, earlier);

  const { logged, exit } = await run(key);

  expect(Exit.isSuccess(exit)).toBe(true);
  expect(logged).toEqual([]);
  expect(await get(buckets.sources, `${storedAt}/${requestID}/01-business-closure`)).toEqual(earlier);
  expect(await get(buckets.sources, `${storedAt}/${requestID}/02-new-acquisition`)).toEqual(attachments[1]!.content);
  await absent(buckets.inbox, key);
});

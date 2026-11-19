import { receivedAtFromRecord } from '@leads/lambda/events/s3';
import { recordsFromMessage } from '@leads/lambda/events/sqs';
import { readBody, toSourceFile } from '@leads/pipeline/domain/Transformations/file';
import { toLeadsAndRejectionsFromRecords } from '@leads/pipeline/domain/Transformations/leads';
import { toLeadsAndRejectionsFromSheet } from '@leads/pipeline/domain/Transformations/leadSources';
import { makeEmailParserLive } from '@leads/pipeline/infrastructure/EmailParser/live';
import { ExcelSheetParserLive } from '@leads/pipeline/infrastructure/ExcelSheetParser/live';
import { GuardLive } from '@leads/pipeline/infrastructure/Guard/live';
import { EmailParser } from '@leads/pipeline/ports/EmailParser';
import { ExcelSheetParser } from '@leads/pipeline/ports/ExcelSheetParser';
import { Guard } from '@leads/pipeline/ports/Guard';
import { RequestID } from '@leads/shared/domain/request';
import { File } from '@leads/shared/domain/types';
import type { SQSRecord } from 'aws-lambda';
import { ConfigProvider, Effect, Layer } from 'effect';
import { simpleParser } from 'mailparser';
import { beforeAll, expect, test } from 'vitest';

import { enFaker, faker } from '../faker';
import { type Case, cases, type Check, type Context, fileName } from './cases';

const context: Context = {
  rows: 2,
  owner: 'owner@example.com',
  recipient: 'noreply@cdk.ses.example.com',
  region: 'eu-north-1',
  buckets: { inbox: 'catalog-inbox', leadSources: 'catalog-lead-sources' },
};

const layer = Layer.mergeAll(
  makeEmailParserLive(simpleParser),
  ExcelSheetParserLive,
  GuardLive.pipe(
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ INBOX_SENDER_WHITELIST: [context.owner] })))
  )
);

const run = <A, E>(effect: Effect.Effect<A, E, EmailParser | ExcelSheetParser | Guard>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

/** What the sources handler gets from a workbook: its leads and rejected rows, or the tag of its error. */
const workbookOutcome = (body: Buffer) =>
  run(
    Effect.gen(function* () {
      const buffer = yield* readBody(File.make({ bucket: 'b', key: 'k', body }), 'HandleLeadSources');
      const { leads, leadRejections } = yield* toLeadsAndRejectionsFromSheet(
        yield* (yield* ExcelSheetParser).parse(buffer)
      );
      return {
        leads: leads.length,
        rejected: leadRejections.length,
        uniqueKeys: new Set(leads.map((lead) => lead.idempotencyKey)).size,
      };
    }).pipe(Effect.catch((error) => Effect.succeed({ error: error._tag })))
  );

/** What the inbox handler gets from an email: the keys of its sources, or the reason of its rejection. */
const emailOutcome = (body: Buffer) =>
  run(
    Effect.gen(function* () {
      const email = yield* (yield* EmailParser).parse(File.make({ bucket: 'b', key: 'k', body }));
      yield* (yield* Guard).authorize(email);
      const attachments = email.attachments.map((attachment, index) =>
        toSourceFile('b', { folder: 'f', subFolder: 's', requestID: RequestID.make('r') }, index, attachment)
          .key.split('/')
          .pop()
      );
      return { authorized: true, attachments };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(error._tag === 'Unauthorized' ? { rejected: String(error.reason) } : { error: error._tag })
      )
    )
  );

const leadOutcome = (body: Buffer) =>
  Effect.runPromise(
    toLeadsAndRejectionsFromRecords([{ messageId: 'm', body: body.toString() }]).pipe(
      Effect.map(({ leads }) => ({ accepted: leads.size === 1 }))
    )
  );

const notificationOutcome = (body: Buffer) => {
  try {
    const records = recordsFromMessage({ messageId: 'm', body: body.toString() } as SQSRecord);
    records.forEach(receivedAtFromRecord);
    return { records: records.length };
  } catch {
    return { throws: true };
  }
};

const outcomeOf = (check: Check, body: Buffer): Promise<object> | object => {
  switch (check.kind) {
    case 'workbook':
      return workbookOutcome(body);
    case 'email':
      return emailOutcome(body);
    case 'lead':
      return leadOutcome(body);
    case 'notification':
      return notificationOutcome(body);
  }
};

// Cases that share data, such as A7-03a and A7-03b, must be built in the order of the catalog.
const built = new Map<Case, Buffer>();
beforeAll(() => {
  faker.seed(42);
  enFaker.seed(42);
  for (const item of cases) if (!item.large && item.check !== undefined) built.set(item, item.build(context));
});

test('every file name is unique in its folder', () => {
  const names = cases.map((item) => `${item.destination}/${fileName(item)}`);
  expect(new Set(names).size).toBe(names.length);
});

test.each(
  cases.filter((item) => !item.large && item.check !== undefined).map((item) => [fileName(item), item] as const)
)('%s gives the outcome of its case', async (_, item) => {
  const check = typeof item.check === 'function' ? item.check(context) : item.check!;
  const { kind: _kind, ...expected } = check;
  expect(await outcomeOf(check, built.get(item)!)).toMatchObject(expected);
});

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type { Message } from '@aws-sdk/client-sqs';
import { requestFolderOf, sourceKey } from '@leads/shared/domain/keys';
import type { RequestID } from '@leads/shared/domain/request';
import type { Lead } from '@leads/shared/domain/types';
import { Effect, Exit, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { handler as handleInbox } from '#Core/Pipeline/Application/UseCases/HandleInbox/handler';
import { handler as handleLead, LeadNotHandled } from '#Core/Pipeline/Application/UseCases/HandleLead/handler';
import { handler as handleLeadSources } from '#Core/Pipeline/Application/UseCases/HandleLeadSources/handler';
import { exitOnTestClock } from '#Core/Pipeline/Application/UseCases/testing/clock';
import { email, type Attachment } from '#Core/Pipeline/Application/UseCases/testing/email';
import { storedAt, instant, leadRecords, makeFloci } from '#Core/Pipeline/Application/UseCases/testing/floci';
import { newRequestID } from '#Core/Pipeline/Application/UseCases/testing/request';
import { sources, workbook } from '#Core/Pipeline/Application/UseCases/testing/workbooks';
import { decodeQueuedLead } from '#Core/Pipeline/Domain/queuedLead';
import { OrderRepository, OrderStoreFailed } from '#Core/Pipeline/Ports/OrderRepository';

const floci = makeFloci();
const { buckets } = floci;

beforeAll(() => floci.setup());
afterAll(() => floci.cleanup());

function logCapture() {
  return { errors: [] as unknown[], warnings: [] as unknown[] };
}

async function runInbox(key: string, sourcesBucket?: string) {
  const logged = logCapture();
  await Effect.runPromise(
    exitOnTestClock(
      handleInbox({ bucket: buckets.inbox, key, receivedAt: instant, functionName: 'inboxHandler' })
    ).pipe(Effect.flatten, Effect.provide(floci.services(logged, undefined, sourcesBucket)))
  );
  return logged;
}

async function runSource(key: string) {
  const logged = logCapture();
  await Effect.runPromise(
    handleLeadSources({
      bucket: buckets.sources,
      key,
      functionName: 'leadSourcesHandler',
    }).pipe(Effect.provide(floci.services(logged)))
  );
  return logged;
}

async function runLead(messages: readonly Message[], orderRepository: Layer.Layer<OrderRepository>) {
  const logged = logCapture();
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* TestClock.setTime(instant.getTime());
      return yield* handleLead({
        records: leadRecords(messages),
        functionName: 'leadHandler',
        source: 'floci-pipeline-test',
      });
    }).pipe(Effect.provide(floci.services(logged, orderRepository)))
  );
  return { exit, logged };
}

const leadFor = (message: Message) => Effect.runSync(decodeQueuedLead(message.Body)).lead;

async function submit(key: string, from: string, attachments: readonly Attachment[]) {
  const body = email(from, attachments);
  await floci.put(buckets.inbox, key, body);
  return { body, logged: await runInbox(key) };
}

/** The key that the inbox handler gives the only attachment of an email. */
const sourceKeyOf = (requestID: RequestID, filename: string) =>
  sourceKey({ ...requestFolderOf(instant, requestID), index: 0, filename });

/** The inbox handler puts the 1-based position of each attachment before its name. */
function sourceKeysFor(requestID: string, names: readonly string[]) {
  return names.map((name, index) => `${storedAt}/${requestID}/${String(index + 1).padStart(2, '0')}-${name}`);
}

async function keysFor(bucket: string, requestID: string) {
  return (await floci.keys(bucket)).filter((key) => key.includes(requestID)).sort();
}

test('processes an email through Inbox and LeadSources into six LeadsQueue messages', async () => {
  const requestID = newRequestID();
  const inboxKey = `received/${requestID}`;
  const attachments = sources.map((source) => ({
    filename: `${source.name}.xlsx`,
    content: workbook(source.header, source.rows),
  }));
  const { logged } = await submit(inboxKey, 'Owner <owner@example.com>', attachments);
  expect(logged).toEqual({ errors: [], warnings: [] });
  expect(await floci.exists(buckets.inbox, inboxKey)).toBe(false);
  const sourceKeys = sourceKeysFor(
    requestID,
    sources.map((source) => source.name)
  );
  for (const key of sourceKeys) {
    expect(await runSource(key)).toEqual({
      errors: [],
      warnings: [],
    });
    expect(await floci.exists(buckets.sources, key)).toBe(false);
  }
  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(6);
  const payloads = messages.map((message) => JSON.parse(message.Body!));
  expect(payloads.map((payload) => payload.requestID)).toEqual(Array.from({ length: 6 }, () => requestID));
  expect(payloads.map(({ lead }) => `${lead.extraction_source}:${lead.extracted.name}`).sort()).toEqual(
    sources
      .flatMap((source) =>
        source.rows.map(
          (row) => `${source.type}:${'Zukünftiger_Betriebsname' in row ? row.Zukünftiger_Betriebsname : row.Name}`
        )
      )
      .sort()
  );
  expect(await floci.keys(buckets.sources)).toEqual([]);
  for (const message of messages) await floci.acknowledge(message);
});

test('routes one email through all three use cases and delivers all six queued leads', async () => {
  const requestID = newRequestID();
  const inboxKey = `received/${requestID}`;
  const attachments = sources.map((source) => ({
    filename: `${source.name
      .split('-')
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(' ')}.xlsx`,
    content: workbook(source.header, source.rows),
  }));
  const { logged: inboxLogs } = await submit(inboxKey, 'Owner <owner@example.com>', attachments);

  expect(inboxLogs).toEqual({ errors: [], warnings: [] });
  expect(await floci.exists(buckets.inbox, inboxKey)).toBe(false);
  const sourceKeys = sourceKeysFor(
    requestID,
    sources.map((source) => source.name)
  );
  expect((await floci.keys(buckets.sources)).sort()).toEqual([...sourceKeys].sort());

  for (const [index, key] of sourceKeys.entries()) {
    expect(await floci.get(buckets.sources, key)).toEqual(attachments[index]!.content);
    expect(await runSource(key)).toEqual({ errors: [], warnings: [] });
    expect(await floci.exists(buckets.sources, key)).toBe(false);
  }

  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(6);
  const delivered: Lead[] = [];
  const orderRepository = Layer.succeed(OrderRepository, {
    store: (lead) =>
      Effect.sync(() => {
        delivered.push(lead);
      }),
  });
  const result = await runLead(messages, orderRepository);
  expect(result.exit).toEqual(Exit.succeed([]));
  expect(result.logged).toEqual({ errors: [], warnings: [] });
  expect(delivered).toHaveLength(6);
  expect(delivered.toSorted((a, b) => (a.extracted.name ?? '').localeCompare(b.extracted.name ?? ''))).toEqual(
    messages.map(leadFor).toSorted((a, b) => (a.extracted.name ?? '').localeCompare(b.extracted.name ?? ''))
  );
  for (const message of messages) await floci.acknowledge(message);
  expect(await floci.receiveLeads()).toEqual([]);

  const expected = sources
    .flatMap((source) =>
      source.rows.map(
        (row) => `${source.type}:${'Zukünftiger_Betriebsname' in row ? row.Zukünftiger_Betriebsname : row.Name}`
      )
    )
    .sort();
  expect(delivered.map((lead) => `${lead.extraction_source}:${lead.extracted.name}`).sort()).toEqual(expected);
});

test('logs an unauthorized sender and deletes the inbox object', async () => {
  const requestID = newRequestID();
  const inboxKey = `received/${requestID}`;
  const attachment = { filename: 'Unauthorized Source.xlsx', content: workbook(sources[1].header, sources[1].rows) };
  const { logged } = await submit(inboxKey, 'External <external@example.org>', [attachment]);

  expect(logged.errors).toMatchObject([{ _tag: 'Unauthorized' }]);
  expect(await floci.exists(buckets.inbox, inboxKey)).toBe(false);
  expect(await floci.exists(buckets.sources, sourceKeyOf(requestID, 'Unauthorized Source.xlsx'))).toBe(false);
});

test('fails the inbox event and leaves the email in place when its attachment bucket is unavailable', async () => {
  const requestID = newRequestID();
  const inboxKey = `received/${requestID}`;
  const attachment = { filename: 'Unavailable Source.xlsx', content: workbook(sources[1].header, sources[1].rows) };
  const body = email('Owner <owner@example.com>', [attachment]);
  await floci.put(buckets.inbox, inboxKey, body);

  await expect(runInbox(inboxKey, `missing-sources-${randomUUID()}`)).rejects.toMatchObject({
    _tag: 'InboxEventNotHandled',
    reason: { _tag: 'AttachmentsNotStored', failures: [{ _tag: 'FileNotStored' }] },
  });
  expect(await floci.get(buckets.inbox, inboxKey)).toEqual(body);
  expect(await floci.exists(buckets.sources, sourceKeyOf(requestID, 'Unavailable Source.xlsx'))).toBe(false);
});

test('delivers queued leads from a valid attachment while an invalid sibling workbook is rejected and deleted', async () => {
  const requestID = newRequestID();
  const inboxKey = `received/${requestID}`;
  const good = { filename: 'Valid Source.xlsx', content: workbook(sources[1].header, sources[1].rows) };
  const bad = { filename: 'Broken Source.xlsx', content: Buffer.from('not an xlsx workbook') };
  const { logged: inboxLogs } = await submit(inboxKey, 'Owner <owner@example.com>', [good, bad]);

  expect(inboxLogs).toEqual({ errors: [], warnings: [] });
  expect(await floci.exists(buckets.inbox, inboxKey)).toBe(false);
  expect((await floci.keys(buckets.sources)).sort()).toEqual(
    sourceKeysFor(requestID, ['valid-source', 'broken-source'])
  );

  expect(await runSource(`${storedAt}/${requestID}/01-valid-source`)).toEqual({
    errors: [],
    warnings: [],
  });
  const brokenKey = `${storedAt}/${requestID}/02-broken-source`;
  expect(await runSource(brokenKey)).toMatchObject({
    errors: [{ _tag: 'LeadSourceNotExtracted', key: brokenKey, reason: { _tag: 'NotAnExcelDocument' } }],
    warnings: [],
  });
  expect(await keysFor(buckets.sources, requestID)).toEqual([]);

  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(2);
  const delivered: Lead[] = [];
  const orderRepository = Layer.succeed(OrderRepository, {
    store: (lead) =>
      Effect.sync(() => {
        delivered.push(lead);
      }),
  });
  const result = await runLead(messages, orderRepository);
  expect(result.exit).toEqual(Exit.succeed([]));
  expect(result.logged).toEqual({ errors: [], warnings: [] });
  expect(delivered).toHaveLength(2);
  for (const message of messages) await floci.acknowledge(message);
  expect(delivered.map((lead) => lead.extracted.name).sort()).toEqual(sources[1].rows.map((row) => row.Name).sort());
});

test('returns only the failed message ID from a mixed queue batch and redelivers only that lead', async () => {
  const requestID = newRequestID();
  const inboxKey = `received/${requestID}`;
  const attachment = { filename: 'Order Outcome.xlsx', content: workbook(sources[1].header, sources[1].rows) };
  const { logged: inboxLogs } = await submit(inboxKey, 'Owner <owner@example.com>', [attachment]);
  expect(inboxLogs).toEqual({ errors: [], warnings: [] });
  expect(await floci.exists(buckets.inbox, inboxKey)).toBe(false);
  expect(await runSource(`${storedAt}/${requestID}/01-order-outcome`)).toEqual({
    errors: [],
    warnings: [],
  });
  expect(await floci.exists(buckets.sources, `${storedAt}/${requestID}/01-order-outcome`)).toBe(false);

  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(2);
  const failedMessage = messages.find((message) => leadFor(message).extracted.name === 'Marktgasse Bistro AG')!;
  const goodMessage = messages.find((message) => message.MessageId !== failedMessage.MessageId)!;
  const attempted: Lead[] = [];
  const delivered: Lead[] = [];
  const orderRepository = Layer.succeed(OrderRepository, {
    store: (lead) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          attempted.push(lead);
        });
        if (lead.extracted.name === 'Marktgasse Bistro AG') {
          return yield* new OrderStoreFailed({ reason: 'downstream unavailable' });
        }
        yield* Effect.sync(() => {
          delivered.push(lead);
        });
      }),
  });
  const result = await runLead([failedMessage, goodMessage], orderRepository);
  const notHandled = new LeadNotHandled({
    messageId: failedMessage.MessageId!,
    reason: new OrderStoreFailed({ reason: 'downstream unavailable' }),
  });
  expect(result.exit).toEqual(Exit.succeed([notHandled]));
  expect(result.logged).toEqual({ errors: [notHandled], warnings: [] });
  expect(attempted.map((lead) => lead.extracted.name).sort()).toEqual(sources[1].rows.map((row) => row.Name).sort());
  expect(delivered.map((lead) => lead.extracted.name)).toEqual(['Seeblick Gastronomie GmbH']);
  // Emulate selective acknowledgement rather than claiming that direct use-case execution does it.
  await floci.acknowledge(goodMessage);
  await floci.releaseLead(failedMessage);
  const retry = await floci.receiveLeads();
  expect(retry.map((message) => message.MessageId)).toEqual([failedMessage.MessageId]);
  const recovered = await runLead(
    retry,
    Layer.succeed(OrderRepository, {
      store: (lead) =>
        Effect.sync(() => {
          delivered.push(lead);
        }),
    })
  );
  expect(recovered.exit).toEqual(Exit.succeed([]));
  expect(recovered.logged).toEqual({ errors: [], warnings: [] });
  expect(delivered.map((lead) => lead.extracted.name).sort()).toEqual(sources[1].rows.map((row) => row.Name).sort());
  await floci.acknowledge(retry[0]!);
  expect(await floci.receiveLeads()).toEqual([]);
});

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { Cause, Effect, Exit } from 'effect';
import { afterAll, beforeAll, expect, test } from 'vitest';

import { exitOnTestClock } from '#Core/Pipeline/Application/UseCases/testing/clock';
import { makeFloci } from '#Core/Pipeline/Application/UseCases/testing/floci';
import { newRequestID } from '#Core/Pipeline/Application/UseCases/testing/request';
import { sources, workbook } from '#Core/Pipeline/Application/UseCases/testing/workbooks';

import { handler } from './handler';

const floci = makeFloci();
const { buckets } = floci;

beforeAll(() => floci.setup());
afterAll(() => floci.cleanup());

async function execute(key: string, leadsQueueUrl?: string) {
  const logged = { errors: [] as unknown[], warnings: [] as unknown[] };
  const exit = await Effect.runPromise(
    exitOnTestClock(
      handler({
        bucket: buckets.sources,
        key,
        functionName: 'leadSourcesHandler',
      })
    ).pipe(Effect.provide(floci.services(logged, undefined, undefined, leadsQueueUrl)))
  );
  return { exit, logged };
}

async function run(key: string) {
  const { exit, logged } = await execute(key);
  expect(exit).toEqual(Exit.succeed(undefined));
  return logged;
}

/** Runs a source that must fail, and checks that the handler logged the error that the DLQ message does not carry. */
async function runFailed(key: string, leadsQueueUrl?: string) {
  const { exit, logged } = await execute(key, leadsQueueUrl);
  if (!Exit.isFailure(exit)) throw new Error('Expected a failed Exit');
  const error = Cause.squash(exit.cause);
  expect(logged.errors).toEqual([error]);
  return { error, logged };
}

/** Runs a source that the handler must reject, and checks that it logged only the rejection and still succeeded. */
async function runRejected(key: string) {
  const { exit, logged } = await execute(key);
  expect(exit).toEqual(Exit.succeed(undefined));
  expect(logged.errors).toHaveLength(1);
  return { rejection: logged.errors[0], logged };
}

test.each(sources)('extracts $type workbook into one SQS message per lead', async (source) => {
  const requestID = newRequestID();
  const key = `received/${requestID}/${source.name}.xlsx`;
  const body = workbook(source.header, source.rows);
  await floci.put(buckets.sources, key, body);

  const logged = await run(key);

  expect(logged).toEqual({ errors: [], warnings: [] });
  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(source.rows.length);
  const payloads = messages.map((message) => JSON.parse(message.Body!));
  expect(payloads.map((payload) => payload.requestID)).toEqual(source.rows.map(() => requestID));
  expect(payloads.map((payload) => payload.lead.extraction_source)).toEqual(source.rows.map(() => source.type));
  expect(payloads.map((payload) => payload.lead.extracted.name).sort()).toEqual(
    source.rows.map((row) => ('Zukünftiger_Betriebsname' in row ? row.Zukünftiger_Betriebsname : row.Name)).sort()
  );
  for (const message of messages) await floci.acknowledge(message);
  expect(await floci.exists(buckets.sources, key)).toBe(false);
});

test('keeps a valid workbook row and reports the rejected row index', async () => {
  const source = sources[1];
  const requestID = newRequestID();
  const key = `received/${requestID}/mixed.xlsx`;
  const body = workbook(source.header, [source.rows[0], { Name: 'K.A.', Ort: '.' }]);
  await floci.put(buckets.sources, key, body);

  const logged = await run(key);

  expect(logged.errors).toEqual([]);
  expect(logged.warnings).toMatchObject([[{ index: 1, message: expect.stringContaining('Row is empty') }]]);
  const messages = await floci.receiveLeads();
  expect(messages).toHaveLength(1);
  expect(JSON.parse(messages[0]!.Body!)).toMatchObject({
    requestID,
    lead: { extraction_source: 'new_acquisition', extracted: { name: 'Seeblick Gastronomie GmbH' } },
  });
  await floci.acknowledge(messages[0]!);
  expect(await floci.exists(buckets.sources, key)).toBe(false);
});

test('rejects a workbook with no valid rows and deletes it without queueing leads', async () => {
  const source = sources[1];
  const requestID = newRequestID();
  const key = `received/${requestID}/no-valid-rows.xlsx`;
  const body = workbook(source.header, [{ Name: 'K.A.', Ort: '.' }]);
  await floci.put(buckets.sources, key, body);

  const { rejection, logged } = await runRejected(key);

  expect(rejection).toMatchObject({ _tag: 'NoValidLeadsExtracted', bucket: buckets.sources, key });
  expect(logged.warnings).toMatchObject([[{ index: 0, message: expect.stringContaining('Row is empty') }]]);
  expect(await floci.receiveLeads()).toEqual([]);
  expect(await floci.exists(buckets.sources, key)).toBe(false);
});

test.each([
  { name: 'non-workbook', body: Buffer.from('not an xlsx file'), reason: 'NotAnExcelDocument' },
  {
    name: 'unknown-header',
    body: workbook(['Company', 'Owner'], [{ Company: 'Alpenblick', Owner: 'Mara' }]),
    reason: 'UnknownLeadsSource',
  },
])('rejects a $name source and deletes it without queueing leads', async ({ name, body, reason }) => {
  const requestID = newRequestID();
  const key = `received/${requestID}/${name}.xlsx`;
  await floci.put(buckets.sources, key, body);

  const { rejection } = await runRejected(key);

  expect(rejection).toMatchObject({
    _tag: 'LeadSourceNotExtracted',
    bucket: buckets.sources,
    key,
    reason: { _tag: reason },
  });
  expect(await floci.receiveLeads()).toEqual([]);
  expect(await floci.exists(buckets.sources, key)).toBe(false);
});

test('fails a source and keeps it in place when its lead cannot be queued', async () => {
  const source = sources[1];
  const requestID = newRequestID();
  const key = `received/${requestID}/store-failure.xlsx`;
  const body = workbook(source.header, [source.rows[0]]);
  await floci.put(buckets.sources, key, body);

  const missingQueueUrl = floci.queueUrl.replace(/[^/]+$/, `missing-leads-${randomUUID()}`);
  const { error, logged } = await runFailed(key, missingQueueUrl);

  expect(error).toMatchObject({
    _tag: 'LeadSourceNotHandled',
    reason: { _tag: 'LeadBatchesNotStored', failures: [{ _tag: 'MessageNotPushed', requestID }] },
  });
  expect(logged.warnings).toEqual([]);
  expect(await floci.receiveLeads()).toEqual([]);
  expect(await floci.get(buckets.sources, key)).toEqual(body);
});

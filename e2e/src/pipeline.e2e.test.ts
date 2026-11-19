import { Buffer } from 'node:buffer';

import type { Fault, Observation, Stage } from '@leads/lambda/e2e/control';
import { sources, workbook } from '@leads/pipeline/testing/workbooks';
import type { SQSBatchResponse } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import v from 'voca';

import { attemptsOf, makeDeployedPipeline, recordsIn, successesOf } from './harness';

const pipeline = makeDeployedPipeline();
beforeAll(() => pipeline.setup());
afterAll(async () => {
  try {
    await pipeline.assertNoDlqConsumers();
  } finally {
    pipeline.dispose();
  }
});
const source = sources[1];
const attachment = (name = 'valid') => ({ filename: `${name}.xlsx`, content: workbook(source.header, source.rows) });
const lead = (name: string) => ({
  extraction_source: 'new_acquisition',
  idempotencyKey: `key-${name}`,
  extracted: { name },
  raw: { Name: name },
});
const fault = (stage: Stage, method: string, outcome: Fault['outcome'] = 'failure', match?: string): Fault => ({
  stage,
  method,
  outcome,
  ...(match !== undefined && { match }),
});
const leadResponses = (events: readonly Observation[]) =>
  events
    .filter((item) => item.stage === 'leads' && item.kind === 'response')
    .flatMap((item) => (item.value as SQSBatchResponse).batchItemFailures)
    .map((failure) => failure.itemIdentifier)
    .sort();
const namesOf = (events: readonly Observation[]) =>
  successesOf(events, 'leads', 'OrderRepository.store')
    .map((item) => item.identity)
    .sort();
const logged = (events: readonly Observation[]) =>
  JSON.stringify(events.filter((item) => item.kind === 'log').map((item) => item.value));

async function expectDeadLetter(stage: Stage, ids: readonly string[], bodies?: readonly string[]) {
  const messages = (await pipeline.dlqMessages(stage)).filter((item) => ids.includes(item.MessageId!));
  expect(messages.map((item) => item.MessageId).sort()).toEqual([...ids].sort());
  const originalBodies =
    bodies ??
    recordsIn(await pipeline.observations(), stage)
      .filter((item) => ids.includes(item.messageId))
      .map((item) => item.body);
  expect(messages.map((item) => item.Body).sort()).toEqual([...originalBodies].sort());
  await pipeline.assertNoDlqConsumers();
}

/** A source keeps the attachment key: its 1-based position in the email, then the slug of its name. */
async function sourcesNamed(filename: string, position = 1) {
  const storedName = `${String(position).padStart(2, '0')}-${v.slugify(filename)}`;
  return (await pipeline.keys('lead-sources')).filter((key) => key.endsWith(`/${storedName}`));
}

/** A handled email and its handled sources are deleted, so no file of the request stays. */
async function expectDeleted(key: string, sourceNames: readonly string[]) {
  expect(await pipeline.exists('inbox', key)).toBe(false);
  for (const [index, name] of sourceNames.entries()) expect(await sourcesNamed(name, index + 1)).toEqual([]);
}

describe('deployed three-handler pipeline', () => {
  test.each([
    { stage: 'inbox', method: 'Storage.read' },
    { stage: 'inbox', method: 'Storage.store' },
    { stage: 'lead-sources', method: 'Storage.read' },
    { stage: 'lead-sources', method: 'Queue.push' },
  ] as const)(
    '[E2E-RECOVERS-$stage-$method] completes the pipeline after two transient port failures',
    async ({ stage, method }) => {
      const id = await pipeline.begin([{ ...fault(stage, method), failures: 2 }]);
      const key = await pipeline.submit([attachment(id)]);
      const events = await pipeline.settle('leads');

      const attempts = attemptsOf(events, stage, method);
      const identities = new Set(attempts.map((item) => item.identity));
      for (const identity of identities) expect(attempts.filter((item) => item.identity === identity)).toHaveLength(3);
      expect(namesOf(events)).toEqual(source.rows.map((row) => row.Name).sort());
      expect(events.filter((item) => item.kind === 'error')).toEqual([]);
      await expectDeleted(key, [id]);
    }
  );

  test.each(['inbox', 'lead-sources'] as const)(
    '[E2E-%s-SUCCESS-DELETE-IGNORED] acknowledges completed processing when the delete of the input fails',
    async (stage) => {
      const id = await pipeline.begin([fault(stage, 'Storage.delete')]);
      const key = await pipeline.submit([attachment(id)]);
      const events = await pipeline.settle('leads');

      expect(attemptsOf(events, stage, 'Storage.delete')).toHaveLength(3);
      expect(namesOf(events)).toEqual(source.rows.map((row) => row.Name).sort());
      expect(events.filter((item) => item.kind === 'error')).toEqual([]);
      // Only the stage whose delete failed keeps its input.
      expect(await pipeline.exists('inbox', key)).toBe(stage === 'inbox');
      expect(await sourcesNamed(id)).toHaveLength(stage === 'lead-sources' ? 1 : 0);
    }
  );

  test('[E2E-ALL-ATTACHMENTS-FAILED] dead-letters the email when every attachment store exhausts retries', async () => {
    await pipeline.begin([fault('inbox', 'Storage.store')]);
    const key = await pipeline.submit([attachment('first'), attachment('second')]);
    const events = await pipeline.settle('inbox', { inbox: 1 });

    expect(attemptsOf(events, 'inbox', 'Storage.store')).toHaveLength(6);
    expect(recordsIn(events, 'lead-sources')).toEqual([]);
    expect(await pipeline.exists('inbox', key)).toBe(true);
    const records = recordsIn(events, 'inbox');
    await expectDeadLetter(
      'inbox',
      records.map((item) => item.messageId),
      records.map((item) => item.body)
    );
  });

  test('[E2E-OK] processes all three workbook types through all handlers and acknowledges every queue', async () => {
    const id = await pipeline.begin();
    const key = await pipeline.submit(
      sources.map((item) => ({ filename: `${id}-${item.name}.xlsx`, content: workbook(item.header, item.rows) }))
    );
    const events = await pipeline.settle('leads');

    expect(recordsIn(events, 'inbox')).toHaveLength(1);
    expect(recordsIn(events, 'lead-sources')).toHaveLength(3);
    expect(recordsIn(events, 'leads')).toHaveLength(6);
    expect(namesOf(events)).toEqual(
      sources
        .flatMap((item) =>
          item.rows.map((row) => ('Zukünftiger_Betriebsname' in row ? row.Zukünftiger_Betriebsname : row.Name))
        )
        .sort()
    );
    expect(leadResponses(events)).toEqual([]);
    expect(events.filter((item) => item.kind === 'error')).toEqual([]);
    await expectDeleted(
      key,
      sources.map((item) => `${id}-${item.name}`)
    );
  });

  test('[E2E-MIXED-SOURCES] delivers valid sibling workbooks while an invalid workbook is rejected and deleted', async () => {
    const id = await pipeline.begin();
    const key = await pipeline.submit([
      attachment(`${id}-good`),
      { filename: `${id}-bad.xlsx`, content: Buffer.from('not xlsx') },
    ]);
    const events = await pipeline.settle('leads');

    expect(namesOf(events)).toEqual(source.rows.map((row) => row.Name).sort());
    expect(recordsIn(events, 'lead-sources')).toHaveLength(2);
    expect(logged(events)).toContain('LeadSourceNotExtracted');
    expect(logged(events)).toContain('NotAnExcelDocument');
    expect(events.filter((item) => item.kind === 'error')).toEqual([]);
    await expectDeleted(key, [`${id}-good`, `${id}-bad`]);
  });

  test('[E2E-PARTIAL-ATTACHMENTS] keeps the inbox failure in its DLQ while the successfully stored attachment completes', async () => {
    const id = await pipeline.begin([fault('inbox', 'Storage.store', 'failure', 'broken')]);
    const key = await pipeline.submit([attachment(`${id}-broken`), attachment(`${id}-good`)]);
    const events = await pipeline.settle('leads', { inbox: 1 });

    expect(
      attemptsOf(events, 'inbox', 'Storage.store').filter((item) => item.identity?.endsWith('broken'))
    ).toHaveLength(3);
    expect(successesOf(events, 'inbox', 'Storage.store')).toHaveLength(1);
    expect(namesOf(events)).toEqual(source.rows.map((row) => row.Name).sort());
    expect(await pipeline.exists('inbox', key)).toBe(true);
    const records = recordsIn(events, 'inbox');
    await expectDeadLetter(
      'inbox',
      records.map((item) => item.messageId),
      records.map((item) => item.body)
    );
  });

  test('[E2E-PARTIAL-PUBLISH] keeps a partially published workbook in its DLQ while the published lead completes', async () => {
    const id = await pipeline.begin([fault('lead-sources', 'Queue.push', 'failure', 'Marktgasse')]);
    await pipeline.submit([attachment(id)]);
    const events = await pipeline.settle('leads', { 'lead-sources': 1 });

    expect(
      attemptsOf(events, 'lead-sources', 'Queue.push').filter((item) => item.identity === 'Marktgasse Bistro AG')
    ).toHaveLength(3);
    expect(recordsIn(events, 'leads')).toHaveLength(1);
    expect(namesOf(events)).toEqual(['Seeblick Gastronomie GmbH']);
    expect(logged(events)).toContain('MessageNotPushed');
    expect((await pipeline.keys('lead-sources')).filter((key) => key.endsWith(`/01-${v.slugify(id)}`))).toHaveLength(1);
    const records = recordsIn(events, 'lead-sources');
    await expectDeadLetter(
      'lead-sources',
      records.map((item) => item.messageId),
      records.map((item) => item.body)
    );
  });

  test('[E2E-PARTIAL-ORDERS] reports and redrives only a failed lead after a real email traverses all three handlers', async () => {
    const id = await pipeline.begin([fault('leads', 'OrderRepository.store', 'failure', 'Marktgasse')]);
    const key = await pipeline.submit([attachment(id)]);
    const events = await pipeline.settle('leads', { leads: 1 });
    const failed = recordsIn(events, 'leads').filter(
      (item) => JSON.parse(item.body).lead.extracted.name === 'Marktgasse Bistro AG'
    );

    expect(recordsIn(events, 'leads')).toHaveLength(2);
    expect(namesOf(events)).toEqual(['Seeblick Gastronomie GmbH']);
    expect(leadResponses(events)).toEqual(failed.map((item) => item.messageId));
    expect(attemptsOf(events, 'leads', 'OrderRepository.store')).toHaveLength(2);
    await expectDeadLetter(
      'leads',
      failed.map((item) => item.messageId),
      failed.map((item) => item.body)
    );
    await expectDeleted(key, [id]);
  });
});

describe('deployed inbox failure handling', () => {
  test('[E2E-INBOX-UNAUTHORIZED] deletes an email from a foreign sender and acknowledges it without sending anything downstream', async () => {
    const id = await pipeline.begin();
    const key = await pipeline.submit([attachment(id)], 'Outside <outside@example.org>');
    const events = await pipeline.settle('inbox');

    expect(await pipeline.exists('inbox', key)).toBe(false);
    expect(recordsIn(events, 'lead-sources')).toEqual([]);
    expect(events.filter((item) => item.stage === 'inbox' && item.kind === 'error')).toEqual([]);
    expect(events.filter((item) => item.kind === 'log')).not.toHaveLength(0);
  });

  test('[E2E-INBOX-UNAUTHENTICATED] deletes an email from a whitelisted sender that SES did not authenticate', async () => {
    const id = await pipeline.begin();
    const key = await pipeline.submit([attachment(id)], undefined, { authenticated: false });
    const events = await pipeline.settle('inbox');

    expect(logged(events)).toContain('Email is not authenticated by SES');
    expect(await pipeline.exists('inbox', key)).toBe(false);
    expect(recordsIn(events, 'lead-sources')).toEqual([]);
    expect(events.filter((item) => item.stage === 'inbox' && item.kind === 'error')).toEqual([]);
  });

  test.each([
    { id: 'EMPTY', faults: [] as Fault[], body: Buffer.alloc(0) },
    { id: 'PARSE-FAILURE', faults: [fault('inbox', 'EmailParser.parse')], body: undefined },
  ])('[E2E-INBOX-$id] deletes an email that cannot be parsed and acknowledges it', async ({ faults, body }) => {
    const id = await pipeline.begin(faults);
    const key = body === undefined ? await pipeline.submit([attachment(id)]) : `received/${id}.eml`;
    if (body !== undefined) await pipeline.put('inbox', key, body);
    const events = await pipeline.settle('inbox');

    expect(await pipeline.exists('inbox', key)).toBe(false);
    expect(recordsIn(events, 'lead-sources')).toEqual([]);
    expect(events.filter((item) => item.stage === 'inbox' && item.kind === 'error')).toEqual([]);
  });

  test('[E2E-INBOX-NO-ATTACHMENTS] deletes an authorized email with no attachments', async () => {
    await pipeline.begin();
    const key = await pipeline.submit([]);
    const events = await pipeline.settle('inbox');

    expect(await pipeline.exists('inbox', key)).toBe(false);
    expect(recordsIn(events, 'lead-sources')).toEqual([]);
  });

  test('[E2E-INBOX-DELETE-IGNORED] acknowledges rejected input even if deletion exhausts retries', async () => {
    await pipeline.begin([fault('inbox', 'Storage.delete')]);
    const key = await pipeline.submit([], 'Outside <outside@example.org>');
    const events = await pipeline.settle('inbox');

    expect(attemptsOf(events, 'inbox', 'Storage.delete')).toHaveLength(3);
    expect(await pipeline.exists('inbox', key)).toBe(true);
    expect(events.filter((item) => item.kind === 'error')).toEqual([]);
  });
});

describe('deployed source failure handling', () => {
  test.each([
    { id: 'EMPTY', body: () => Buffer.alloc(0), tag: 'File is empty' },
    { id: 'NOT-XLSX', body: () => Buffer.from('not xlsx'), tag: 'NotAnExcelDocument' },
    { id: 'UNKNOWN-HEADER', body: () => workbook(['Unknown'], [{ Unknown: 'value' }]), tag: 'UnknownLeadsSource' },
    {
      id: 'NO-VALID-ROWS',
      body: () => workbook(source.header, [{ Name: 'K.A.', Ort: '.' }]),
      tag: 'NoValidLeadsExtracted',
    },
  ])('[E2E-SOURCE-$id] rejects an invalid workbook, deletes it, and acknowledges its event', async ({ body, tag }) => {
    const id = await pipeline.begin();
    const key = `received/${id}.xlsx`;
    await pipeline.put('lead-sources', key, body());
    const events = await pipeline.settle('lead-sources');

    expect(await pipeline.exists('lead-sources', key)).toBe(false);
    expect(recordsIn(events, 'leads')).toEqual([]);
    expect(logged(events)).toContain(tag);
    expect(events.filter((item) => item.kind === 'error')).toEqual([]);
  });

  test('[E2E-SOURCE-REJECTED-ROW] warns about one invalid row and delivers only the valid row', async () => {
    const id = await pipeline.begin();
    await pipeline.submit([
      { filename: `${id}.xlsx`, content: workbook(source.header, [source.rows[0], { Name: 'K.A.', Ort: '.' }]) },
    ]);
    const events = await pipeline.settle('leads');

    expect(recordsIn(events, 'leads')).toHaveLength(1);
    expect(namesOf(events)).toEqual(['Seeblick Gastronomie GmbH']);
    expect(logged(events)).toContain('Row is empty');
    expect(await sourcesNamed(id)).toEqual([]);
  });

  test('[E2E-SOURCE-ALL-PUBLISH-FAILED] keeps the workbook and dead-letters its event when every publish fails', async () => {
    const id = await pipeline.begin([fault('lead-sources', 'Queue.push')]);
    await pipeline.submit([attachment(id)]);
    const events = await pipeline.settle('lead-sources', { 'lead-sources': 1 });

    expect(attemptsOf(events, 'lead-sources', 'Queue.push')).toHaveLength(6);
    expect(recordsIn(events, 'leads')).toEqual([]);
    expect(logged(events)).toContain('MessageNotPushed');
    expect((await pipeline.keys('lead-sources')).filter((key) => key.endsWith(`/01-${v.slugify(id)}`))).toHaveLength(1);
    const records = recordsIn(events, 'lead-sources');
    await expectDeadLetter(
      'lead-sources',
      records.map((item) => item.messageId),
      records.map((item) => item.body)
    );
  });
});

describe('whole-event failures and stage DLQs', () => {
  test.each(['inbox', 'lead-sources'] as const)(
    '[E2E-%s-SUCCESS-DELETE-DEFECT] dead-letters a defect in the final delete while published siblings complete',
    async (stage) => {
      const method = 'Storage.delete';
      const id = await pipeline.begin([fault(stage, method, 'defect')]);
      await pipeline.submit([attachment(id)]);
      const events = await pipeline.settle('leads', { [stage]: 1 });

      expect(attemptsOf(events, stage, method)).toHaveLength(1);
      expect(namesOf(events)).toEqual(source.rows.map((row) => row.Name).sort());
      expect(events.filter((item) => item.stage === stage && item.kind === 'error')).toHaveLength(1);
      const records = recordsIn(events, stage);
      await expectDeadLetter(
        stage,
        records.map((item) => item.messageId),
        records.map((item) => item.body)
      );
    }
  );

  // The rejected email has no attachments, so the defect hits only the delete of the rejected input.
  test('[E2E-inbox-REJECTION-DELETE-DEFECT] dead-letters a defect during rejected input cleanup', async () => {
    await pipeline.begin([fault('inbox', 'Storage.delete', 'defect')]);
    const key = await pipeline.submit([], 'Outside <outside@example.org>');
    const events = await pipeline.settle('inbox', { inbox: 1 });

    expect(attemptsOf(events, 'inbox', 'Storage.delete')).toHaveLength(1);
    expect(await pipeline.exists('inbox', key)).toBe(true);
    expect(recordsIn(events, 'leads')).toEqual([]);
    const records = recordsIn(events, 'inbox');
    await expectDeadLetter(
      'inbox',
      records.map((item) => item.messageId),
      records.map((item) => item.body)
    );
  });

  test.each(['inbox', 'lead-sources', 'leads'] as const)(
    '[E2E-%s-CONFIG] dead-letters a configuration failure before processing any records',
    async (stage) => {
      const id = await pipeline.begin([], undefined, stage);
      if (stage === 'inbox') await pipeline.submit([]);
      else if (stage === 'lead-sources')
        await pipeline.put('lead-sources', `received/${id}.xlsx`, attachment().content);
      else await pipeline.sendBatch([lead('Config-first'), lead('Config-second')]);
      const events = await pipeline.settle(stage, { [stage]: stage === 'leads' ? 2 : 1 });

      expect(events.filter((item) => item.kind === 'attempt')).toEqual([]);
      expect(events.filter((item) => item.stage === stage && item.kind === 'error')).toHaveLength(1);
      const records = recordsIn(events, stage);
      await expectDeadLetter(
        stage,
        records.map((item) => item.messageId),
        records.map((item) => item.body)
      );
    }
  );

  test.each(['inbox', 'lead-sources'] as const)(
    '[E2E-%s-MALFORMED] redrives malformed S3 notification messages to their own DLQ',
    async (stage) => {
      const id = await pipeline.begin();
      const body = `invalid-notification-${id}`;
      const messageId = await pipeline.poison(stage, body);
      const events = await pipeline.settle(stage, { [stage]: 1 });

      expect(events.filter((item) => item.stage === stage && item.kind === 'error')).toHaveLength(1);
      await expectDeadLetter(stage, [messageId], [body]);
      expect(attemptsOf(events, stage, 'Storage.read')).toEqual([]);
    }
  );

  test.each(['inbox', 'lead-sources'] as const)(
    '[E2E-%s-MISSING] exhausts read retries and dead-letters a notification for a missing object',
    async (stage) => {
      const id = await pipeline.begin();
      const body = JSON.stringify({
        Records: [
          {
            eventTime: new Date().toISOString(),
            s3: { bucket: { name: pipeline.bucket(stage) }, object: { key: `missing/${id}` } },
          },
        ],
      });
      const messageId = await pipeline.poison(stage, body);
      const events = await pipeline.settle(stage, { [stage]: 1 });

      expect(attemptsOf(events, stage, 'Storage.read')).toHaveLength(3);
      expect(events.filter((item) => item.stage === stage && item.kind === 'error')).toHaveLength(1);
      await expectDeadLetter(stage, [messageId], [body]);
    }
  );

  test.each(['inbox', 'lead-sources'] as const)(
    '[E2E-%s-DEFECT] dead-letters a processing defect without continuing downstream',
    async (stage) => {
      const id = await pipeline.begin([fault(stage, 'Storage.read', 'defect')]);
      if (stage === 'inbox') await pipeline.submit([attachment(id)]);
      else await pipeline.put('lead-sources', `received/${id}.xlsx`, attachment().content);
      const events = await pipeline.settle(stage, { [stage]: 1 });
      const records = recordsIn(events, stage);

      expect(attemptsOf(events, stage, 'Storage.read')).toHaveLength(1);
      expect(recordsIn(events, 'leads')).toEqual([]);
      await expectDeadLetter(
        stage,
        records.map((item) => item.messageId),
        records.map((item) => item.body)
      );
    }
  );

  // The inbox takes the folder of the sources from the S3 eventTime, so a record without one cannot be handled.
  test.each(['inbox'] as const)(
    '[E2E-%s-NO-EVENT-TIME] dead-letters a notification without an eventTime before reading the file',
    async (stage) => {
      const id = await pipeline.begin();
      const body = JSON.stringify({
        Records: [{ s3: { bucket: { name: pipeline.bucket(stage) }, object: { key: `received/${id}` } } }],
      });
      const messageId = await pipeline.poison(stage, body);
      const events = await pipeline.settle(stage, { [stage]: 1 });

      expect(attemptsOf(events, stage, 'Storage.read')).toEqual([]);
      expect(events.filter((item) => item.stage === stage && item.kind === 'error')).toHaveLength(1);
      await expectDeadLetter(stage, [messageId], [body]);
    }
  );

  test.each(['inbox', 'lead-sources', 'leads'] as const)(
    '[E2E-%s-SHUTDOWN] propagates runtime shutdown so the message reaches its stage DLQ',
    async (stage) => {
      const method = stage === 'leads' ? 'OrderRepository.store' : 'Storage.read';
      const id = await pipeline.begin([fault(stage, method, 'hang')], stage);
      if (stage === 'inbox') await pipeline.submit([]);
      else if (stage === 'lead-sources')
        await pipeline.put('lead-sources', `received/${id}.xlsx`, attachment().content);
      else await pipeline.sendBatch([lead('Shutdown')]);
      const events = await pipeline.settle(stage, { [stage]: 1 });

      expect(events.filter((item) => item.stage === stage && item.kind === 'error')).toHaveLength(1);
      const records = recordsIn(events, stage);
      await expectDeadLetter(
        stage,
        records.map((item) => item.messageId),
        records.map((item) => item.body)
      );
    }
  );

  test.each(['inbox', 'lead-sources'] as const)(
    '[E2E-%s-TEST-NOTIFICATION] acknowledges S3 destination test events without reading a file',
    async (stage) => {
      await pipeline.begin();
      await pipeline.poison(stage, JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent' }));
      const events = await pipeline.settle(stage);

      expect(attemptsOf(events, stage, 'Storage.read')).toEqual([]);
      expect(events.filter((item) => item.kind === 'error')).toEqual([]);
    }
  );
});

describe('deployed Lead batch acknowledgements', () => {
  test('[E2E-LEADS-SHUTDOWN-PARTIAL] dead-letters the entire delivered batch when shutdown rejects after a sibling succeeds', async () => {
    await pipeline.begin([fault('leads', 'OrderRepository.store', 'hang', 'Hanging')], 'leads');
    const ids = await pipeline.sendBatch([lead('Good'), lead('Hanging')]);
    const events = await pipeline.settle('leads', { leads: 2 });

    expect(namesOf(events)).toEqual(['Good']);
    expect(events.filter((item) => item.stage === 'leads' && item.kind === 'error')).toHaveLength(1);
    expect(leadResponses(events)).toEqual([]);
    await expectDeadLetter('leads', [...ids.values()]);
  });

  test('[E2E-LEADS-BATCH-PARTIAL] processes a full batch of ten and dead-letters only two failed IDs', async () => {
    await pipeline.begin([fault('leads', 'OrderRepository.store', 'failure', 'Broken')]);
    const inputs = [
      lead('Broken-first'),
      ...Array.from({ length: 8 }, (_, index) => lead(`Good-${index}`)),
      lead('Broken-last'),
    ];
    const ids = await pipeline.sendBatch(inputs);
    const events = await pipeline.settle('leads', { leads: 2 });
    const failedIds = [ids.get(0)!, ids.get(9)!].sort();

    expect(events.filter((item) => item.stage === 'leads' && item.kind === 'start')).toHaveLength(1);
    expect(recordsIn(events, 'leads')).toHaveLength(10);
    expect(attemptsOf(events, 'leads', 'OrderRepository.store')).toHaveLength(10);
    expect(namesOf(events)).toEqual(Array.from({ length: 8 }, (_, index) => `Good-${index}`));
    expect(leadResponses(events)).toEqual(failedIds);
    await expectDeadLetter(
      'leads',
      failedIds,
      recordsIn(events, 'leads')
        .filter((item) => failedIds.includes(item.messageId))
        .map((item) => item.body)
    );
  });

  test.each(['AuthenticationFailed', 'OrderStoreTimedOut', 'OrderStoreFailed'] as const)(
    '[E2E-LEADS-%s] retries only eligible errors and redrives the failed message',
    async (error) => {
      await pipeline.begin([{ ...fault('leads', 'OrderRepository.store'), error }]);
      const ids = await pipeline.sendBatch([lead('Failed')]);
      const events = await pipeline.settle('leads', { leads: 1 });

      expect(attemptsOf(events, 'leads', 'OrderRepository.store')).toHaveLength(error === 'OrderStoreFailed' ? 1 : 3);
      expect(leadResponses(events)).toEqual([ids.get(0)]);
      expect(logged(events)).toContain(error);
      await expectDeadLetter('leads', [ids.get(0)!]);
    }
  );

  test('[E2E-LEADS-RECOVERS] acknowledges a retried lead after two adapter timeouts', async () => {
    await pipeline.begin([{ ...fault('leads', 'OrderRepository.store'), error: 'OrderStoreTimedOut', failures: 2 }]);
    await pipeline.sendBatch([lead('Recovered')]);
    const events = await pipeline.settle('leads');

    expect(attemptsOf(events, 'leads', 'OrderRepository.store')).toHaveLength(3);
    expect(namesOf(events)).toEqual(['Recovered']);
    expect(leadResponses(events)).toEqual([]);
  });

  test('[E2E-LEADS-TIMEOUT] times out one hanging lead and acknowledges its successful sibling', async () => {
    await pipeline.begin([fault('leads', 'OrderRepository.store', 'hang', 'Hanging')]);
    const ids = await pipeline.sendBatch([lead('Hanging'), lead('Good')]);
    const events = await pipeline.settle('leads', { leads: 1 });

    expect(namesOf(events)).toEqual(['Good']);
    expect(leadResponses(events)).toEqual([ids.get(0)]);
    expect(logged(events)).toContain('TimeoutError');
    await expectDeadLetter('leads', [ids.get(0)!]);
  });

  test('[E2E-LEADS-DEFECT] captures a store defect and redrives unfinished records', async () => {
    await pipeline.begin([fault('leads', 'OrderRepository.store', 'defect')]);
    const ids = await pipeline.sendBatch([lead('Crashing')]);
    const events = await pipeline.settle('leads', { leads: 1 });

    expect(leadResponses(events)).toEqual([ids.get(0)]);
    expect(events.filter((item) => item.stage === 'leads' && item.kind === 'error')).toEqual([]);
    expect(logged(events)).toContain('LeadNotHandled');
    expect(namesOf(events)).toEqual([]);
    await expectDeadLetter('leads', [ids.get(0)!]);
  });

  test('[E2E-LEADS-REJECTED] dead-letters malformed and invalid records while acknowledging a valid sibling', async () => {
    await pipeline.begin();
    const bodies = ['not-json', JSON.stringify({ lead: { extraction_source: 'unknown' } })];
    const rejectedIds = [await pipeline.poison('leads', bodies[0]!), await pipeline.poison('leads', bodies[1]!)];
    await pipeline.sendBatch([lead('Good')]);
    const events = await pipeline.settle('leads', { leads: 2 });

    expect(recordsIn(events, 'leads')).toHaveLength(3);
    expect(attemptsOf(events, 'leads', 'OrderRepository.store')).toHaveLength(1);
    expect(namesOf(events)).toEqual(['Good']);
    expect(leadResponses(events)).toEqual([...rejectedIds].sort());
    expect(logged(events)).toContain('LeadNotHandled');
    await expectDeadLetter('leads', rejectedIds, bodies);
  });
});

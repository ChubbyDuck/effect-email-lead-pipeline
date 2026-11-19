import { prices } from '@leads/shared/domain/prices';
import type { RequestProgress } from '@leads/shared/domain/request';
import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, test } from 'vitest';

import { requestCostOf, type StageCost } from './requestCost';
import type { HandlerRun, RunLine } from './runs';

const requestID = 'aj8bllniv9qsu5f5gq1jg5v1fkk2grjeqa4u1381';
const otherID = 'bk9cmmojw0rtv6g6hr2kh6w2gll3hsfkrb5v2492';
const receivedAt = '2026-10-13T17:15:34.000Z';
const at = (ms: number) => new Date(Date.parse(receivedAt) + ms).toISOString();

const progress = (change: RequestProgress, request = requestID): RunLine => ({
  time: receivedAt,
  level: 'info',
  message: `Progress of request ${request}: ${JSON.stringify(change)}`,
  progress: { requestID: request, change },
});

const fileSize = (kind: 'email' | 'source', key: string, bytes: number, time = receivedAt): RunLine => ({
  time,
  level: 'info',
  message: `File size of request ${requestID}: ${JSON.stringify({ kind, key, bytes })}`,
  fileSize: { requestID, size: { kind, key, bytes } },
});

const termOf = (stage: StageCost, item: string) => stage.terms.find((term) => term.item === item);

const run = (stage: StageName, fields: Partial<HandlerRun> = {}): HandlerRun => ({
  stage,
  runID: `${stage}-run`,
  logStream: 'stream',
  startedAt: at(1000),
  endedAt: at(2000),
  outcome: 'ended',
  billedMs: 1000,
  memoryMb: 1024,
  errors: 0,
  warnings: 0,
  otherRequests: 0,
  logBytes: 0,
  lines: [],
  truncated: false,
  ...fields,
});

const quantities = (stage: StageCost) => Object.fromEntries(stage.terms.map(({ item, quantity }) => [item, quantity]));

const inboxRun = run('inbox', {
  lines: [progress({ inboxStatus: 'pending' }), progress({ attachments: 3 }), progress({ inboxStatus: 'processed' })],
});

describe('the cost of a request', () => {
  test('counts the receipt of the email and every call of the inbox run', () => {
    const cost = requestCostOf({ requestID, receivedAt, attachments: 3 }, [{ stage: 'inbox', runs: [inboxRun] }]);

    expect(quantities(cost.stages[0]!)).toEqual({
      'email received': 1,
      'chunks of 256 KB': 1,
      'PUT of the email, by SES': 1,
      'sends: the notification of the email': 1,
      receives: 1,
      deletes: 1,
      calls: 1,
      'billed time at 1024 MB': 1,
      'GET of the email': 1,
      'PUT of the sources': 3,
      'ledger writes': 4,
    });
  });

  test('prices the inbox stage at the list prices of the Region', () => {
    const cost = requestCostOf({ requestID, receivedAt }, [{ stage: 'inbox', runs: [inboxRun] }]);

    expect(cost.services).toEqual({
      Lambda: expect.closeTo(prices.lambdaRequest + prices.lambdaGbSecond, 15),
      SQS: expect.closeTo(3 * prices.sqsRequest, 15),
      S3: expect.closeTo(4 * prices.s3Put + prices.s3Get, 15),
      SES: expect.closeTo(prices.sesEmail + prices.sesChunk, 15),
      DynamoDB: expect.closeTo(4 * prices.dynamoWriteUnit, 15),
    });
    expect(cost.cost).toBeCloseTo(cost.stages[0]!.cost, 15);
  });

  test('counts each chunk of 256 KB of the email that the inbox read', () => {
    const inbox = run('inbox', { lines: [...inboxRun.lines, fileSize('email', `received/${requestID}`, 600_000)] });

    const [stage] = requestCostOf({ requestID, receivedAt }, [{ stage: 'inbox', runs: [inbox] }]).stages;

    expect(termOf(stage!, 'chunks of 256 KB')).toMatchObject({
      quantity: 3,
      note: 'The email is 600,000 bytes, so it is 3 chunks of 256 KB.',
    });
  });

  test('keeps one chunk with the current note for a request without the size of its email', () => {
    const [stage] = requestCostOf({ requestID, receivedAt }, [{ stage: 'inbox', runs: [inboxRun] }]).stages;

    expect(termOf(stage!, 'chunks of 256 KB')).toMatchObject({
      quantity: 1,
      note: 'The logs do not give the size of the email, so this is one chunk: a minimum.',
    });
    expect(stage!.terms.filter(({ unit }) => unit === 'GB-month')).toEqual([]);
  });

  test('measures the S3 storage of the email from the store by SES to the delete at the end of the inbox run', () => {
    // 1 GB for 2 s of a month of 720 hours.
    const inbox = run('inbox', { lines: [fileSize('email', `received/${requestID}`, 1024 ** 3)] });

    const [stage] = requestCostOf({ requestID, receivedAt }, [{ stage: 'inbox', runs: [inbox] }]).stages;

    expect(termOf(stage!, 'storage of the email')).toMatchObject({
      service: 'S3',
      quantity: expect.closeTo(1 / 1_296_000, 15),
      unit: 'GB-month',
      unitPrice: prices.s3StorageGbMonth,
    });
  });

  test('measures the S3 storage of each source from the store by the inbox to the delete at the end of its run', () => {
    // Two sources of 0.5 GB, each for 3 s of a month of 720 hours.
    const inbox = run('inbox', { lines: [{ ...progress({ attachments: 2 }), time: at(1000) }] });
    const sources = ['01-a', '02-b'].map((name, index) =>
      run('leadSources', {
        runID: `source-${index}`,
        endedAt: at(4000),
        lines: [fileSize('source', `13-10-2026/17-10/${requestID}/${name}`, 1024 ** 3 / 2, at(1500))],
      })
    );

    const [, stage] = requestCostOf({ requestID, receivedAt, attachments: 2 }, [
      { stage: 'inbox', runs: [inbox] },
      { stage: 'leadSources', runs: sources },
    ]).stages;

    expect(termOf(stage!, 'storage of the sources')).toMatchObject({
      service: 'S3',
      quantity: expect.closeTo(1 / 864_000, 15),
      unit: 'GB-month',
    });
  });

  test('measures the S3 storage of a standalone source from its first read, because no inbox stored it', () => {
    // 1 GB for 2.5 s of a month of 720 hours.
    const source = run('leadSources', {
      endedAt: at(4000),
      lines: [fileSize('source', 'received/leads.xlsx', 1024 ** 3, at(1500))],
    });

    const [, stage] = requestCostOf({ requestID }, [
      { stage: 'inbox', runs: [] },
      { stage: 'leadSources', runs: [source] },
    ]).stages;

    expect(termOf(stage!, 'storage of the sources')?.quantity).toBeCloseTo(1 / 1_036_800, 15);
  });

  test('pushes the leads of a source in batches of ten', () => {
    const source = run('leadSources', {
      lines: [
        progress({ sourcesPending: 1 }),
        progress({ sourcesLeads: 25 }),
        progress({ sourcesPending: -1, sourcesProcessed: 1 }),
      ],
    });

    const [stage] = requestCostOf({ requestID, receivedAt, attachments: 1 }, [
      { stage: 'leadSources', runs: [source] },
    ]).stages;

    expect(quantities(stage!)).toMatchObject({
      'sends: the notifications of the sources': 1,
      'sends of the leads, 10 in each': 3,
      'GET of the sources': 1,
      'ledger writes': 3,
    });
  });

  test('pays only its own leads of a lead run that other requests share', () => {
    const lead = run('leads', {
      billedMs: 4000,
      memoryMb: 128,
      logBytes: 2000,
      lines: [
        progress({ leadsPending: 3 }),
        progress({ leadsPending: 7 }, otherID),
        progress({ leadsPending: -3, leadsProcessed: 3 }),
        progress({ leadsPending: -7, leadsProcessed: 7 }, otherID),
      ],
    });

    const [stage] = requestCostOf({ requestID, receivedAt }, [{ stage: 'leads', runs: [lead] }]).stages;

    expect(quantities(stage!)).toEqual({
      receives: expect.closeTo(0.3, 10),
      deletes: expect.closeTo(0.3, 10),
      calls: expect.closeTo(0.3, 10),
      'billed time at 128 MB': expect.closeTo(0.3 * 4 * 0.125, 10),
      'log lines taken in': expect.closeTo((0.3 * 2000) / 1024 ** 3, 20),
      'log lines kept one month': expect.closeTo((0.3 * 2000) / 1024 ** 3, 20),
      'order writes': 3,
      'ledger writes': 2,
    });
  });

  test('leaves the time of a run without a REPORT line out, and counts the run', () => {
    const { billedMs: _billed, memoryMb: _memory, endedAt: _ended, ...ended } = run('inbox');
    const running: HandlerRun = { ...ended, outcome: 'running' };

    const cost = requestCostOf({ requestID, receivedAt }, [{ stage: 'inbox', runs: [running] }]);

    expect(cost.unbilledRuns).toBe(1);
    expect(cost.services.Lambda).toBeUndefined();
    expect(cost.endMs).toBeUndefined();
  });

  test('has no receipt of an email for a standalone source', () => {
    const [inbox] = requestCostOf({ requestID }, [
      { stage: 'inbox', runs: [] },
      { stage: 'leadSources', runs: [run('leadSources')] },
    ]).stages;

    expect(inbox).toMatchObject({ runs: 0, cost: 0, terms: [] });
  });

  test('ends each stage at the end of its last run after the email came in', () => {
    const cost = requestCostOf({ requestID, receivedAt }, [
      { stage: 'inbox', runs: [run('inbox', { endedAt: at(900) })] },
      { stage: 'leadSources', runs: [run('leadSources', { endedAt: at(2500) })] },
    ]);

    expect(cost.stages.map(({ endMs }) => endMs)).toEqual([900, 2500]);
    expect(cost.endMs).toBe(2500);
  });
});

import { prices } from '@leads/shared/domain/prices';
import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, test } from 'vitest';

import {
  costsBy,
  costsOf,
  dollars,
  exactDollars,
  lambdaPrice,
  lineFormula,
  monthHours,
  rawDollars,
  runPrice,
  runsPrice,
  sumFormula,
  timePrice,
} from './costs';
import type { Usage } from './snapshot';

const gb = 1024 ** 3;

const queue = (stage: StageName, role: 'main' | 'dlq', counts: Partial<Usage['queues'][number]> = {}) => ({
  name: `${stage}-${role}`,
  stage,
  role,
  sent: 0,
  received: 0,
  deleted: 0,
  emptyReceives: 0,
  ...counts,
});

const usage: Usage = {
  handlers: [
    {
      stage: 'inbox',
      memoryMb: 128,
      invocations: 2,
      durationMs: 8000,
      logGroup: '/aws/lambda/inbox',
      logBytes: gb / 1000,
      logStoredBytes: gb,
    },
  ],
  queues: [
    queue('inbox', 'main', { sent: 2, received: 2, deleted: 2, emptyReceives: 10_000 }),
    queue('leadSources', 'main', { sent: 6, received: 6, deleted: 6 }),
    queue('leads', 'dlq'),
  ],
  tables: [
    { name: 'orders', role: 'orders', readUnits: 0, writeUnits: 30, sizeBytes: 1000 },
    { name: 'request-ledger', role: 'ledger', readUnits: 500, writeUnits: 40, sizeBytes: 1000 },
  ],
  emailBytes: [],
  metricsPerRead: 66,
};

const report = costsOf(usage, 3);
const costOf = (item: string) => report.lines.find((line) => line.item === item)?.cost;

describe('the costs of a window', () => {
  test('price the Lambda calls and the GB-seconds of each handler at its memory', () => {
    expect(costOf('calls')).toBeCloseTo(2 * prices.lambdaRequest);
    expect(costOf('compute at 128 MB')).toBeCloseTo(8 * 0.125 * prices.lambdaGbSecond);
  });

  test('take the S3 calls and the SES emails from the notifications to the queues', () => {
    expect(costOf('PUT of the emails, by SES')).toBeCloseTo(2 * prices.s3Put);
    expect(costOf('GET of the sources')).toBeCloseTo(6 * prices.s3Get);
    expect(costOf('emails received')).toBeCloseTo(2 * prices.sesEmail);
  });

  test('count one SES chunk for each email without a size line: a minimum', () => {
    expect(report.lines.find(({ item }) => item === 'chunks of 256 KB received')).toMatchObject({
      quantity: 2,
      note: 'One chunk for each email: the logs give no size of an email, so this is a minimum.',
    });
  });

  test('count the real SES chunks of each email with a size line', () => {
    const chunks = (emailBytes: readonly number[]) =>
      costsOf({ ...usage, emailBytes }, 3).lines.find(({ item }) => item === 'chunks of 256 KB received');

    // 600,000 bytes are 3 chunks, and exactly 256 KB is 1 chunk.
    expect(chunks([600_000, 256 * 1024])).toMatchObject({
      quantity: 4,
      note: 'The size line of each email that the inbox read gives its chunks.',
    });
    // The second email of the window has no size line yet, so it is one chunk.
    expect(chunks([600_000])).toMatchObject({
      quantity: 4,
      note: 'The size lines give the chunks of 1 of the 2 emails. Each other email is one chunk: a minimum.',
    });
  });

  test('count the empty polls as idle, and every other cost as work', () => {
    expect(report.idle).toBeCloseTo(10_000 * prices.sqsRequest);
    expect(report.work + report.idle + report.monitor).toBeCloseTo(report.total);
    expect(report.lines.filter(({ kind }) => kind === 'idle').map(({ item }) => item)).toEqual([
      'empty polls of the trigger',
    ]);
  });

  test('leave out the lines without usage, and put the largest cost first', () => {
    expect(report.lines.every(({ quantity }) => quantity > 0)).toBe(true);
    expect(report.lines.map(({ cost }) => cost)).toEqual(
      report.lines.map(({ cost }) => cost).toSorted((a, b) => b - a)
    );
  });

  test('count the reads of the ledger as the cost of this lab, not of the requests', () => {
    expect(report.monitor).toBeCloseTo(500 * prices.dynamoReadUnit);
  });

  test('give the ledger to no stage, and the orders to the leads', () => {
    expect(report.lines.find(({ item }) => item.startsWith('request-ledger writes'))?.owner).toBe('shared');
    expect(report.lines.find(({ item }) => item.startsWith('orders writes'))?.owner).toBe('leads');
  });

  test('project a month at the rate of the window, with a month of storage', () => {
    expect(report.storageTotal).toBeCloseTo(prices.logStorageGbMonth);
    expect(report.perMonth).toBeCloseTo((report.total * monthHours) / 3 + report.storageTotal);
  });

  test('price the metrics of one read of the lab', () => {
    expect(report.perRead).toBeCloseTo(66 * prices.metricRequested);
  });

  test('add up the costs by service, the largest first', () => {
    const services = costsBy(report.lines, ({ service }) => service);

    expect(services[0]?.key).toBe('SQS');
    expect(services.reduce((total, { cost }) => total + cost, 0)).toBeCloseTo(report.total);
  });
});

test('a run costs its call and its billed time at its memory, and says how', () => {
  expect(runPrice({ billedMs: 1016, memoryMb: 1536 })).toEqual({
    cost: prices.lambdaRequest + 1.016 * 1.5 * prices.lambdaGbSecond,
    formula: '1.5 GB × 1.016 s × $0.0000166667 per GB-s + $0.0000002 per call',
  });
  expect(runPrice({ memoryMb: 128 })).toBeUndefined();
});

test('a duration bills each started ms, and a call when it is a whole run', () => {
  expect(timePrice(0.2, 1024)).toEqual({
    cost: 0.001 * prices.lambdaGbSecond,
    formula: '1 GB × 0.001 s × $0.0000166667 per GB-s',
  });
  expect(lambdaPrice(1000, 1024).cost).toBeCloseTo(prices.lambdaRequest + prices.lambdaGbSecond);
});

test('runs cost their GB-seconds and their calls together, without the runs that have no REPORT line', () => {
  const price = runsPrice([{ billedMs: 1000, memoryMb: 1024 }, { billedMs: 2000, memoryMb: 512 }, { memoryMb: 128 }]);

  expect(price.cost).toBeCloseTo(2 * prices.lambdaGbSecond + 2 * prices.lambdaRequest);
  expect(price.formula).toBe('2 GB-s × $0.0000166667 per GB-s + 2 calls × $0.0000002 per call');
});

test('a line is its quantity at its raw unit price, and a sum shows its parts', () => {
  expect(lineFormula(report.lines.find(({ item }) => item === 'empty polls of the trigger')!)).toBe(
    '10,000 call × $0.0000004'
  );
  expect(sumFormula([0.0084, 0.00336])).toBe('$0.0084 + $0.00336');
  expect(rawDollars(prices.dynamoReadUnit)).toBe('$0.0000001345');
});

test.each([
  [0, '$0'],
  [0.000123456, '$0.000123'],
  [0.0258, '$0.0258'],
  [2.5, '$2.50'],
  [1234.4, '$1,234'],
])('the cost %d shows as %s', (value, text) => {
  expect(dollars(value)).toBe(text);
});

test.each([
  [0, '$0'],
  [0.000010187520375, '$0.00001018752'],
  [0.0001, '$0.0001'],
  [1.5, '$1.5'],
])('an exact cost of %d reads %s', (value, text) => {
  expect(exactDollars(value)).toBe(text);
});

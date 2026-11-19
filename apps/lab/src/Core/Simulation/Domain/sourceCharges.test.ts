import { toLeadsAndRejectionsFromSheet } from '@leads/pipeline/domain/Transformations/leadSources';
import { sources } from '@leads/pipeline/testing/workbooks';
import { prices } from '@leads/shared/domain/prices';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { logCost, logIngestCost, logLineBytes, logStorageCost, sourceLogBytes } from './logs';
import { inMegabytes, workbookBytes } from './payloads';
import { scheduleSlice } from './schedule';
import { leadBatchSends, payloadRequests, sourceCharges, sqsBatchLimitBytes, sqsChunkBytes } from './sourceCharges';
import { sourceDuration } from './sources';
import { sliceDefaults } from './testing/roundDefaults';

/** One write unit for each write of the request entry. */
const ledger = (writes: number) => writes * prices.dynamoWriteUnit;

const requestID = '12345678-1234-4234-8234-123456789abc';

const oneHandler = (duration: number, leads: number, bytes: number, memory = sliceDefaults.src_M) =>
  prices.lambdaRequest +
  (duration / 1000) * (memory / 1024) * prices.lambdaGbSecond +
  prices.s3Get +
  leadBatchSends(leads, bytes).requests * prices.sqsRequest +
  logCost(sourceLogBytes({ L: leads }));

describe('Source charges', () => {
  it('sizes one lead above the mean of the six workbook fixtures', async () => {
    const sizes: number[] = [];
    for (const source of sources) {
      const { leads } = await Effect.runPromise(
        toLeadsAndRejectionsFromSheet({
          header: [...source.header],
          rows: source.rows.map((row) => ({ ...row })),
        })
      );
      for (const lead of leads) sizes.push(Buffer.byteLength(JSON.stringify({ lead, requestID })));
    }
    expect(sizes).toHaveLength(6);
    const mean = Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length);
    expect(mean).toBe(770);
    expect(sliceDefaults.lead_b).toBeGreaterThanOrEqual(mean);
  });

  it('follows the source clock and prices one source, then every source and every cold start', () => {
    const input = { ...sliceDefaults, E: 10, L: 100_000 };
    const schedule = scheduleSlice(input);
    const charges = sourceCharges(input, schedule);
    const handler = oneHandler(sourceDuration(input), input.L, input.lead_b);
    const sources = input.E * input.S;

    expect(payloadRequests(10 * input.lead_b)).toBe(1);
    expect(leadBatchSends(input.L, input.lead_b).requests).toBe(10_000);
    expect(charges.lines.map((line) => line.label)).toEqual([
      'Source consumption',
      'Handlers',
      'Ledger writes',
      'Cold starts',
    ]);
    expect(charges.lines[0]?.warning).toContain('The sources queue is set to one message per call.');
    expect(charges.lines[0]?.warning).toContain(
      'Consumption for these 100 sources would go from 300 requests ($0.00012) to 120 ($0.000048)'
    );
    expect(charges.lines[1]?.warning).toBeUndefined();
    const first = schedule.releases[0]!.at;
    expect(charges.lines.map((line) => line.time.value)).toEqual([
      input.delay_src,
      schedule.sources.end - first - input.delay_src,
      3 * input.src_request_ledger_record_t,
      input.src_init_t,
    ]);
    expect(charges.lines[1]?.time).toMatchObject({
      formula: 'last source bar end − first source arrival',
      substitution: `T = 20 + 200 + ${inMegabytes(workbookBytes(input))} MB × 20 + 150 + 20 + ceil(ceil(100000 / 10) / 200) × 120 + 20 + 40 ms; ${schedule.sources.end} − (${first} + 25) ms`,
    });
    expect(charges.lines[1]?.pure.substitution).toContain(
      `10000 × ceil(10 × ${sliceDefaults.lead_b} / ${sqsChunkBytes}) × $0.0000004`
    );
    expect(charges.lines[1]?.pure.value).toBe(handler);
    expect(charges.lines[1]?.applied.value).toBe(sources * handler);
    const cold =
      (input.src_init_t / 1000) * (input.src_M / 1024) * prices.lambdaGbSecond +
      logIngestCost(logLineBytes.coldStart) +
      logStorageCost(logLineBytes.coldStart);
    expect(charges.lines[2]?.pure).toMatchObject({ value: ledger(3), services: { DynamoDB: ledger(3) } });
    expect(charges.lines[2]?.applied.value).toBeCloseTo(sources * ledger(3), 15);
    expect(charges.lines[3]?.applied.value).toBe(schedule.sources.environments * cold);
    expect(charges.time).toMatchObject({
      value: schedule.sources.end - first,
      formula: 'last source bar end − first source release',
    });
    expect(charges.applied.value).toBeCloseTo(sources * charges.pure.value + schedule.sources.environments * cold, 12);
    expect(charges.pure.value).toBeCloseTo(3 * prices.sqsRequest + handler + ledger(3), 15);
    expect(charges.applied.formula).toBe('E × S sources × (consumption + handler + ledger) + cold starts');
  });

  it('bills a full batch and the remainder batch on their own payloads', () => {
    const input = { ...sliceDefaults, L: 25, E: 1, S: 1, S_q_c: 1 };
    const pure = sourceCharges(input).lines[1]?.pure;

    expect(leadBatchSends(25, sliceDefaults.lead_b)).toMatchObject({ full: 2, remainder: 5, requests: 3 });
    expect(pure?.substitution).toContain(`2 × ceil(10 × ${sliceDefaults.lead_b} / ${sqsChunkBytes}) × $0.0000004`);
    expect(pure?.substitution).toContain(`1 × ceil(5 × ${sliceDefaults.lead_b} / ${sqsChunkBytes}) × $0.0000004`);
    expect(pure?.value).toBe(oneHandler(sourceDuration(input), 25, sliceDefaults.lead_b));
  });

  it('bills a second SQS request once a batch passes 64 KB', () => {
    const bytes = Math.ceil((sqsChunkBytes + 1) / 10);
    const input = { ...sliceDefaults, L: 10, lead_b: bytes, E: 1, S: 1, S_q_c: 1 };
    const charges = sourceCharges(input);
    const handler = oneHandler(sourceDuration(input), 10, bytes);

    expect(leadBatchSends(10, bytes).requests).toBe(2);
    expect(charges.lines[1]?.warning).toContain('is 2 SQS requests');
    expect(charges.lines[1]?.warning).not.toContain('rejects');
    expect(charges.lines[1]?.pure.substitution).toContain(`1 × ceil(10 × ${bytes} / ${sqsChunkBytes}) × $0.0000004`);
    expect(charges.lines[1]?.pure.value).toBe(handler);
  });

  it('warns that SQS rejects a batch over 1 MiB', () => {
    const bytes = Math.ceil((sqsBatchLimitBytes + 1) / 10);
    const charges = sourceCharges({ ...sliceDefaults, L: 10, lead_b: bytes });

    expect(charges.lines[1]?.warning).toContain('SQS rejects a batch over 1,048,576 bytes');
  });

  it('drops the lead sends when a source has no leads', () => {
    const input = { ...sliceDefaults, E: 1, S: 1, L: 0, delay_src: 0 };
    const duration = sourceDuration(input);
    const charges = sourceCharges(input);
    const handler = charges.lines[1];

    expect(handler?.time.substitution.startsWith('T = 20 + 200 + 0 MB × 20 + 150 + 0 × 120 + 20 + 40 ms')).toBe(true);
    expect(charges.lines[2]?.time).toMatchObject({ value: 40, substitution: '2 × 20 ms' });
    expect(charges.lines[2]?.pure.value).toBe(ledger(2));
    expect(handler?.pure.value).toBe(oneHandler(duration, 0, input.lead_b));
    expect(handler?.pure.substitution).toContain('0 × $0.0000004');
  });

  it('bills compute at the source handler memory', () => {
    const input = { ...sliceDefaults, E: 1, S: 1, src_M: 3072 };
    const handler = sourceCharges(input).lines[1]?.pure;

    expect(handler?.value).toBe(oneHandler(sourceDuration(input), input.L, input.lead_b, 3072));
    expect(handler?.substitution).toContain('3 GB');
  });

  it('prices nothing when an email has no sources', () => {
    const input = { ...sliceDefaults, S: 0 };
    const charges = sourceCharges(input);

    expect(charges.lines[0]?.warning).toBeUndefined();
    expect(charges.lines[0]?.time.value).toBe(0);
    expect(charges.lines[1]?.time.value).toBe(0);
    expect(charges.lines[2]?.time.value).toBe(0);
    expect(charges.lines[3]?.time.value).toBe(0);
    expect(charges.time.value).toBe(0);
    expect(charges.applied.value).toBe(0);
    expect(charges.pure.value).toBeGreaterThan(0);
  });
});

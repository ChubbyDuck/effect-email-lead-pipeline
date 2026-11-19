import { prices } from '@leads/shared/domain/prices';
import { describe, expect, it } from 'vitest';

import { dollars } from './charges';
import { leadCharges, leadConsumption, orderWriteUnits } from './leadCharges';
import { leadDuration, leadTokenWait } from './leads';
import { leadLogBytes, logCost, logIngestCost, logLineBytes, logStorageCost } from './logs';
import { scheduleSlice } from './schedule';
import { sliceDefaults } from './testing/roundDefaults';

const oneHandler = (leads: number, input = sliceDefaults, wait = 0) =>
  prices.lambdaRequest +
  (leadDuration(input, leads, wait) / 1000) * (input.ld_M / 1024) * prices.lambdaGbSecond +
  logCost(leadLogBytes(input, leads));

describe('Lead charges', () => {
  it('receives ten leads per call and deletes them with one delete-batch', () => {
    expect(leadConsumption(10, 800)).toEqual({ calls: 1, receives: 1, deletes: 1, requests: 2 });
    expect(leadConsumption(25, 800)).toEqual({ calls: 3, receives: 3, deletes: 3, requests: 6 });
    expect(leadConsumption(10, 7000)).toMatchObject({ receives: 2, requests: 3 });
    expect(leadConsumption(0, 800)).toEqual({ calls: 0, receives: 0, deletes: 0, requests: 0 });
  });

  it('follows the lead clock and prices one batch, then every batch and every cold start', () => {
    // No batch waits for tokens here, so every batch costs the same.
    const input = { ...sliceDefaults, ld_writes: 1_000_000 };
    const schedule = scheduleSlice(input);
    const charges = leadCharges(input, schedule);
    const batches = (sliceDefaults.E * sliceDefaults.S * sliceDefaults.L) / sliceDefaults.ld_batch;
    const consumption = 2 * prices.sqsRequest;
    const handler = oneHandler(10, input);
    const writes = 10 * prices.dynamoWriteUnit;
    const ledger = 2 * prices.dynamoWriteUnit;
    const cold =
      (sliceDefaults.ld_init_t / 1000) * (sliceDefaults.ld_M / 1024) * prices.lambdaGbSecond +
      logIngestCost(logLineBytes.coldStart) +
      logStorageCost(logLineBytes.coldStart);
    const first = schedule.leadReleases[0]!.at;

    expect(charges.lines.map((line) => line.label)).toEqual([
      'Lead consumption',
      'Handlers',
      'Order writes',
      'Ledger writes',
      'Cold starts',
    ]);
    expect(charges.lines.map((line) => line.time.value)).toEqual([
      sliceDefaults.delay_ld,
      schedule.leads.end - first - sliceDefaults.delay_ld,
      sliceDefaults.ld_order_repository_store_t,
      2 * sliceDefaults.ld_request_ledger_record_t,
      sliceDefaults.ld_init_t,
    ]);
    expect(charges.lines[1]?.warning).toBeUndefined();
    expect(charges.lines[1]?.time.substitution.startsWith('T = 20 + 1 × 20 + ceil(10 / 10) × 20 + 1 × 20 ms')).toBe(
      true
    );
    expect(charges.lines[0]?.pure.value).toBe(consumption);
    expect(charges.lines[1]?.pure.value).toBe(handler);
    expect(charges.lines[0]?.applied.value).toBeCloseTo(batches * consumption, 12);
    expect(charges.lines[1]?.applied.value).toBeCloseTo(batches * handler, 12);
    expect(charges.lines[1]?.applied.substitution).toBe(`${batches} batches of 10 × ${dollars(handler)}`);
    expect(charges.lines[2]?.pure.value).toBe(writes);
    expect(charges.lines[2]?.applied.value).toBeCloseTo(batches * writes, 12);
    expect(charges.lines[3]?.pure).toMatchObject({ value: ledger, substitution: '2 × 1 × 1 × $0.00000067' });
    expect(charges.lines[3]?.applied.value).toBeCloseTo(batches * ledger, 12);
    expect(charges.lines[4]?.applied.value).toBe(schedule.leads.environments * cold);
    expect(charges.time).toMatchObject({
      value: schedule.leads.end - first,
      formula: 'last lead bar end − first lead release',
    });
    expect(charges.pure.value).toBe(consumption + handler + writes + ledger);
    expect(charges.applied.value).toBeCloseTo(
      batches * (consumption + handler + writes + ledger) + schedule.leads.environments * cold,
      12
    );
  });

  it('bills the wait for tokens: the pure price waits, and the applied price counts each batch with its own wait', () => {
    const input = { ...sliceDefaults, E: 1, S: 1, L: 30, esm_start: 1, esm_rate: 0, L_q_c: 1 };
    const handlers = leadCharges(input).lines[1];
    const warm = oneHandler(10, input, 920);
    const cold = oneHandler(10, input);

    expect(handlers?.pure.value).toBe(warm);
    expect(handlers?.applied.value).toBeCloseTo(cold + 2 * warm, 15);
    expect(handlers?.applied.substitution).toContain('3 batches of 10 × ');
    expect(handlers?.time.substitution.startsWith('T = 20 + 1 × 20 + 920 + ceil(10 / 10) × 20 + 1 × 20 ms')).toBe(true);
    expect(handlers?.detail).toContain('waits 920 ms');
  });

  it('prices a partial batch on its own and warns that it waited the batching window', () => {
    const input = { ...sliceDefaults, E: 1, S: 1, L: 25 };
    const charges = leadCharges(input);
    const handlers = charges.lines[1];

    expect(handlers?.warning).toContain('5 leads did not fill a batch of 10.');
    expect(handlers?.warning).toContain('ld_window_t = 10,000 ms');
    expect(handlers?.applied.substitution).toContain('2 batches of 10 × ');
    expect(handlers?.applied.substitution).toContain('1 batch of 5 × ');
    expect(handlers?.applied.value).toBeCloseTo(2 * oneHandler(10, input) + oneHandler(5, input), 15);
    expect(charges.lines[0]?.applied.value).toBeCloseTo(2 * 2 * prices.sqsRequest + 2 * prices.sqsRequest, 15);
  });

  it('bills one write request unit for each started KB of a lead, and leaves the storage to the detail', () => {
    expect([0, 800, 1024, 1025, 4000].map(orderWriteUnits)).toEqual([1, 1, 1, 2, 4]);
    const input = { ...sliceDefaults, E: 1, S: 1, L: 10, lead_b: 2000 };
    const writes = leadCharges(input).lines[2];

    expect(writes?.pure).toMatchObject({
      value: 10 * 2 * prices.dynamoWriteUnit,
      substitution: '10 × 2 × $0.00000067',
    });
    expect(writes?.applied.value).toBe(10 * 2 * prices.dynamoWriteUnit);
    expect(writes?.detail).toContain('$0.269 per GB-month');
    expect(writes?.detail).toContain('not in this bill');
  });

  it('warns when a batch does not fit one invocation payload', () => {
    const charges = leadCharges({ ...sliceDefaults, E: 1, S: 1, L: 10, lead_b: 1_000_000 });

    expect(charges.lines[1]?.warning).toContain('over the 6 MB Lambda payload');
    expect(charges.lines[1]?.warning).toContain('invokes a handler with 6 leads instead');
  });

  it('bills compute at the lead handler memory', () => {
    const input = { ...sliceDefaults, E: 1, S: 1, L: 10, ld_M: 1024 };
    const handler = leadCharges(input).lines[1]?.pure;

    expect(handler?.value).toBe(oneHandler(10, input, leadTokenWait(input, 10)));
    expect(handler?.substitution).toContain('1 GB');
  });

  it('writes one start and one end for each request in a batch', () => {
    const input = { ...sliceDefaults, ld_requests: 3 };
    const ledger = leadCharges(input).lines[3];

    expect(ledger?.pure.value).toBe(6 * prices.dynamoWriteUnit);
    expect(ledger?.time).toMatchObject({ value: 40, substitution: '2 × ceil(3 / 10) × 20 ms' });
    expect(ledger?.detail).toContain('ld_requests = 3 requests');
  });

  it('prices nothing when the sources hold no leads', () => {
    const charges = leadCharges({ ...sliceDefaults, L: 0 });

    expect(charges.lines.map((line) => line.time.value)).toEqual([
      0,
      0,
      sliceDefaults.ld_order_repository_store_t,
      2 * sliceDefaults.ld_request_ledger_record_t,
      0,
    ]);
    expect(charges.time.value).toBe(0);
    expect(charges.applied.value).toBe(0);
    expect(charges.pure.value).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from 'vitest';

import {
  leadDuration,
  leadLedgerWaves,
  leadLedgerWrites,
  leadRequests,
  leadSpans,
  leadStoreWaves,
  leadsPerHandler,
  leadTimeline,
  leadTokenWait,
} from './leads';
import { leadDefaults as realLeadDefaults } from './leads';
import { normalizeSliceInputs } from './sources';
import { sliceDefaults as realSliceDefaults } from './sources';
import { sliceDefaults } from './testing/roundDefaults';

const slice = (overrides: Partial<typeof sliceDefaults> = {}) =>
  normalizeSliceInputs({ ...sliceDefaults, ...overrides });

describe('Lead handlers', () => {
  it('stores a batch of ten in one store wave of 20 ms, between the start and the end of its request', () => {
    expect(leadStoreWaves(sliceDefaults, 10)).toBe(1);
    expect(leadDuration(sliceDefaults, 10)).toBe(20 + 20 + 20 + 20);
    expect(leadDuration(slice({ ld_c: 3 }), 10)).toBe(20 + 20 + 4 * 20 + 20);
    expect(leadDuration(sliceDefaults, 0)).toBe(20);
  });

  it('writes one start and one end for each request in the batch, up to ld_c at once', () => {
    expect(leadRequests(sliceDefaults, 10)).toBe(1);
    expect(leadLedgerWrites(sliceDefaults, 10)).toBe(2);
    const mixed = slice({ ld_requests: 25, ld_c: 10 });
    expect(leadRequests(mixed, 10)).toBe(10);
    expect(leadRequests(mixed, 100)).toBe(25);
    expect(leadLedgerWrites(mixed, 100)).toBe(50);
    expect(leadLedgerWaves(mixed, 100)).toBe(3);
    expect(leadTimeline(mixed, 100).steps.find((step) => step.output)!.start).toBe(20 + 3 * 20);
    expect(leadLedgerWrites(mixed, 0)).toBe(0);
    expect(slice({ ld_requests: 0 }).ld_requests).toBe(1);
  });

  it('cuts a batch down to the leads that fit one invocation payload', () => {
    expect(leadsPerHandler(sliceDefaults)).toBe(10);
    expect(leadsPerHandler(slice({ lead_b: 1_000_000 }))).toBe(6);
    expect(leadsPerHandler(slice({ lead_b: 10_000_000 }))).toBe(1);
    expect(leadsPerHandler(slice({ lead_b: 0, ld_batch: 10_000 }))).toBe(10_000);
  });

  it('splits one handler into a parse, the starts, its store waves, and the ends', () => {
    expect(
      leadSpans(sliceDefaults, 10).map(({ tone, symbol, call, start, end, amount }) => [
        tone,
        symbol,
        call,
        start,
        end,
        amount,
      ])
    ).toEqual([
      ['parse', 'ld_records_parse_t', 'toLeadsAndRejectionsFromRecords', 0, 20, undefined],
      ['ledger', 'ld_request_ledger_record_t', 'RequestLedger.record', 20, 40, undefined],
      ['store', 'ld_order_repository_store_t', 'OrderRepository.store', 40, 60, 10],
      ['ledger', 'ld_request_ledger_record_t', 'RequestLedger.record', 60, 80, undefined],
    ]);
    expect(leadSpans(slice({ ld_c: 3 }), 10).map((span) => span.amount)).toEqual([
      undefined,
      undefined,
      3,
      3,
      3,
      1,
      undefined,
    ]);
  });

  it('draws many store waves as one stretch', () => {
    const store = leadSpans(slice({ ld_batch: 100, ld_c: 1 }), 100).find((span) => span.tone === 'store');
    expect(store).toMatchObject({
      start: 40,
      end: 2040,
      amount: 100,
      detail: '100 store waves, each storing up to 1 lead, taking 20 ms.',
    });
  });

  it('makes a handler that follows the previous batch wait for all the tokens of its batch', () => {
    expect(leadTokenWait(sliceDefaults, 10)).toBe(1000 - 80);
    expect(leadTokenWait(slice({ ld_writes: 5 }), 10)).toBe(2000 - 80);
    expect(leadTokenWait(sliceDefaults, 0)).toBe(0);
  });

  it('counts the tokens that the bucket got back while the environment rested', () => {
    expect(leadTokenWait(sliceDefaults, 10, 500)).toBe(500 - 80);
    expect(leadTokenWait(sliceDefaults, 10, 920)).toBe(0);
    expect(leadTokenWait(sliceDefaults, 10, 60_000)).toBe(0);
  });

  it('starts a new environment with a full bucket, so only a larger batch waits', () => {
    expect(leadTokenWait(sliceDefaults, 10, Number.POSITIVE_INFINITY)).toBe(0);
    const large = slice({ ld_batch: 30 });
    expect(leadTokenWait(large, 30, Number.POSITIVE_INFINITY)).toBe(2000 - leadDuration(large, 30));
    expect(leadTokenWait(large, 30, 60_000)).toBe(2000 - leadDuration(large, 30));
  });

  it('does not wait when the handler itself runs as long as its tokens take', () => {
    expect(leadTokenWait(slice({ ld_order_repository_store_t: 2000 }), 10)).toBe(0);
  });

  it('draws the wait before the stores and holds the orders until the wait ends', () => {
    const wait = leadTokenWait(sliceDefaults, 10);
    expect(leadDuration(sliceDefaults, 10, wait)).toBe(1000);
    expect(
      leadSpans(sliceDefaults, 10, 0, wait).map(({ tone, symbol, start, end }) => [tone, symbol, start, end])
    ).toEqual([
      ['parse', 'ld_records_parse_t', 0, 20],
      ['ledger', 'ld_request_ledger_record_t', 20, 40],
      ['wait', 'ld_writes', 40, 960],
      ['store', 'ld_order_repository_store_t', 960, 980],
      ['ledger', 'ld_request_ledger_record_t', 980, 1000],
    ]);
  });

  it('keeps the batch, the window, and the memory inside the AWS limits', () => {
    expect(slice({ ld_batch: 20_000 }).ld_batch).toBe(10_000);
    expect(slice({ ld_batch: 0 }).ld_batch).toBe(1);
    expect(slice({ ld_window_t: 400_000 }).ld_window_t).toBe(300_000);
    expect(slice({ ld_window_t: -1 }).ld_window_t).toBe(0);
    expect(slice({ ld_M: 64 }).ld_M).toBe(128);
    expect(slice({ delay_ld: -1 }).delay_ld).toBe(0);
    expect(slice({ ld_writes: 0 }).ld_writes).toBe(1);
  });

  it('opens at the lead defaults the stack deploys and at the measured times', () => {
    expect(realLeadDefaults).toMatchObject({
      L_q_c: 200,
      ld_batch: 10,
      ld_window_t: 10_000,
      ld_c: 10,
      ld_writes: 10,
      ld_M: 128,
      delay_ld: 52,
      ld_records_parse_t: 78,
      ld_order_repository_store_t: 399,
      ld_request_ledger_record_t: 99,
      ld_init_t: 581,
    });
    expect(realSliceDefaults).toMatchObject(realLeadDefaults);
  });
});

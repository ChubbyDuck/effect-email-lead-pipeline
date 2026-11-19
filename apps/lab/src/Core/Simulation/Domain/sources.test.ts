import { handlerSettings } from '@leads/shared/domain/handlerSettings';
import { orderWritesPerSecond } from '@leads/shared/domain/orderWrites';
import { QueueBatchSize } from '@leads/shared/domain/queueLimits';
import { describe, expect, it, test } from 'vitest';

import {
  leadBatchSize,
  normalizeSliceInputs,
  sourceDuration,
  sourceReadTime,
  sourceBatches,
  sourceSendWaves,
  sourceLedgerWrites,
  sourceSpans,
  sliceDefaults as realSliceDefaults,
} from './sources';
import { sliceDefaults } from './testing/roundDefaults';

/** Latency only: no S3 call takes longer for its bytes, unless a test sets a time per MB. */
const slice = (overrides: Partial<typeof sliceDefaults> = {}) =>
  normalizeSliceInputs({ ...sliceDefaults, in_storage_mb_t: 0, src_storage_mb_t: 0, ...overrides });

describe('Source handlers', () => {
  it('batches leads as the leads queue port does', () => {
    expect(leadBatchSize).toBe(QueueBatchSize);
    expect(sourceBatches(slice({ L: 0 }))).toBe(0);
    expect(sourceBatches(slice({ L: 10 }))).toBe(1);
    expect(sourceBatches(slice({ L: 11 }))).toBe(2);
  });

  it('pushes 100,000 leads in fifty send waves of 120 ms in one source handler', () => {
    const input = slice({ L: 100_000 });
    expect(sourceBatches(input)).toBe(10_000);
    expect(sourceSendWaves(input)).toBe(50);
    expect(sourceDuration(input)).toBe(6450);
  });

  it('reads the workbook bytes at src_storage_mb_t', () => {
    const input = slice({ L: 1024, row_b: 1024, src_storage_mb_t: 30 });
    expect(sourceReadTime(input)).toBe(200 + 30);
    expect(sourceDuration(input)).toBe(
      20 + slice({ L: 1024, row_b: 1024 }).src_storage_read_t + 30 + 150 + 20 + 120 + 20 + 40
    );
  });

  it('deletes an empty source without sending or recording leads', () => {
    const input = slice({ L: 0, delay_in: 0, delay_src: 0 });
    expect(sourceDuration(input)).toBe(430);
    expect(sourceSpans(input).map((span) => span.tone)).toEqual(['ledger', 'get', 'parse', 'ledger', 'delete']);
    expect(sourceSpans(input)[3]!.detail).toContain('rejected');
    expect(sourceLedgerWrites(input)).toBe(2);
  });

  it('records its start, the leads it found before the first send, and its end after the last send', () => {
    const input = slice({ L: 25, src_c: 2 });
    const spans = sourceSpans(input);
    expect(spans.map((span) => span.tone)).toEqual([
      'ledger',
      'get',
      'parse',
      'ledger',
      'send',
      'send',
      'ledger',
      'delete',
    ]);
    expect(spans[3]!.end).toBe(spans[4]!.start);
    expect(spans[3]!.detail).toContain('25 leads');
    expect(sourceLedgerWrites(input)).toBe(3);
  });

  it('draws each batch send wave when there are only a few, and one stretch when there are many', () => {
    const few = slice({ L: 25, src_c: 2 });
    expect(
      sourceSpans(few)
        .filter((span) => span.tone === 'send')
        .map((span) => [span.name, span.calls, span.amount])
    ).toEqual([
      ['Queue.pushBatch', 2, 20],
      ['Queue.pushBatch', 1, 5],
    ]);
    const many = slice({ L: 100_000 });
    const send = sourceSpans(many).find((span) => span.tone === 'send');
    expect(send).toMatchObject({
      name: 'Queue.pushBatch',
      start: 390,
      end: 6390,
      amount: 100_000,
      calls: 10_000,
      detail: '50 send waves, each pushing up to 200 batches of 10 leads, taking 120 ms.',
    });
  });

  it('keeps source handler memory inside the Lambda limits', () => {
    expect(slice({ src_M: 64 }).src_M).toBe(128);
    expect(slice({ src_M: 20_000 }).src_M).toBe(10_240);
    expect(slice({ src_M: 2048.5 }).src_M).toBe(2048);
  });

  it('floors lead bytes and keeps a zero', () => {
    expect(slice({ lead_b: 771.9 }).lead_b).toBe(771);
    expect(slice({ lead_b: -5 }).lead_b).toBe(0);
    expect(slice({ row_b: -5 }).row_b).toBe(0);
    expect(slice({ esm_rate: 0 }).esm_rate).toBe(0);
  });

  it('keeps the opening inbox defaults beside the source knobs, with the measured times', () => {
    expect(realSliceDefaults).toMatchObject({
      E: 50,
      S: 10,
      L: 10_000,
      lead_b: 800,
      row_b: 300,
      src_M: 1536,
      S_q_c: 50,
      delay_in: 959,
      in_request_ledger_acknowledge_t: 99,
      in_storage_read_t: 889,
      in_email_parser_parse_t: 179,
      in_storage_store_t: 199,
      in_storage_delete_t: 21,
      in_request_ledger_record_t: 99,
      in_init_t: 567,
      delay_src: 900,
      src_request_ledger_record_t: 20,
      src_storage_read_t: 104,
      src_excel_sheet_parser_parse_t: 7,
      src_queue_push_t: 10,
      src_storage_delete_t: 26,
      src_init_t: 469,
    });
  });
});

// The stack deploys the same shared settings, so the simulator starts from what is deployed.
test('starts from the settings of the deployed handlers', () => {
  expect(realSliceDefaults).toMatchObject({
    E_q_c: handlerSettings.stageCaps.inbox,
    S_q_c: handlerSettings.stageCaps.leadSources,
    L_q_c: handlerSettings.stageCaps.leads,
    ld_batch: handlerSettings.leadBatchSize,
    ld_window_t: handlerSettings.leadBatchingWindow,
    in_c: handlerSettings.internalConcurrency.inbox,
    src_c: handlerSettings.internalConcurrency.leadSources,
    ld_c: handlerSettings.internalConcurrency.leads,
    src_M: handlerSettings.memorySize.leadSources,
    ld_M: handlerSettings.memorySize.leads,
    ld_writes: orderWritesPerSecond.environment,
  });
});

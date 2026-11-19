import { handlerTimeouts } from '@leads/shared/domain/handlerTimeouts';
import { describe, expect, it } from 'vitest';

import { inboxDuration } from './inbox';
import { leadDuration } from './leads';
import { maxRowsPerSource, maxSourcesPerEmail, sesMaxBytes, sliceLimits } from './limits';
import { emailBytes } from './payloads';
import { normalizeSliceInputs, sourceDuration } from './sources';
import { sliceDefaults } from './testing/roundDefaults';

const slice = (overrides: Partial<typeof sliceDefaults> = {}) =>
  normalizeSliceInputs({ ...sliceDefaults, ...overrides });

describe('Slice limits', () => {
  it('runs the defaults inside every limit', () => {
    expect(sliceLimits(sliceDefaults)).toEqual([]);
  });

  it('flags an email of ten workbooks of 100,000 rows as too large for SES', () => {
    const limits = sliceLimits(slice({ L: 100_000 }));
    expect(limits.map((limit) => limit.keys)).toEqual([['S', 'L', 'row_b']]);
    expect(limits[0]?.title).toContain('SES bounces an email over 40 MB');
  });

  it('gives the largest L and S that still fit one email', () => {
    const input = slice({ L: 100_000 });
    const rows = maxRowsPerSource(input);
    expect(emailBytes(slice({ L: rows }))).toBeLessThanOrEqual(sesMaxBytes);
    expect(emailBytes(slice({ L: rows + 1 }))).toBeGreaterThan(sesMaxBytes);
    expect(maxSourcesPerEmail(input)).toBe(1);
    const sources = maxSourcesPerEmail(slice({ L: 10_000 }));
    expect(emailBytes(slice({ L: 10_000, S: sources }))).toBeLessThanOrEqual(sesMaxBytes);
    expect(emailBytes(slice({ L: 10_000, S: sources + 1 }))).toBeGreaterThan(sesMaxBytes);
  });

  it('accepts one workbook of 100,000 rows', () => {
    expect(sliceLimits(slice({ S: 1, L: 100_000 }))).toEqual([]);
  });

  it('flags a source handler that runs past its timeout', () => {
    const input = slice({ S: 1, L: 6_000_000, row_b: 0 });
    expect(input.src_init_t + sourceDuration(input)).toBeGreaterThan(handlerTimeouts.source);
    const limits = sliceLimits(input);
    expect(limits.map((limit) => limit.keys)).toEqual([['L', 'src_c', 'src_storage_mb_t']]);
    const most = Number(/L can be at most ([\d,]+)/.exec(limits[0]!.detail)![1]!.replaceAll(',', ''));
    const fits = slice({ S: 1, L: most, row_b: 0 });
    expect(fits.src_init_t + sourceDuration(fits)).toBeLessThanOrEqual(handlerTimeouts.source);
    const over = slice({ S: 1, L: most + 1, row_b: 0 });
    expect(over.src_init_t + sourceDuration(over)).toBeGreaterThan(handlerTimeouts.source);
  });

  it('flags an inbox handler that runs past its timeout', () => {
    const input = slice({ S: 1000, in_c: 1, L: 0 });
    expect(input.in_init_t + inboxDuration(input)).toBeGreaterThan(handlerTimeouts.inbox);
    const limits = sliceLimits(input);
    expect(limits.map((limit) => limit.keys)).toEqual([['S', 'in_c', 'in_storage_mb_t']]);
    expect(limits[0]?.detail).toContain('S can be at most 493');
  });

  it('counts the bytes of a large workbook against the source timeout', () => {
    // A 5 MB workbook at 60 s per MB: the read takes about 300 s.
    const input = slice({ S: 1, L: 20_000, row_b: 262, src_storage_mb_t: 60_000 });
    expect(input.src_init_t + sourceDuration(input)).toBeGreaterThan(handlerTimeouts.source);
    const limits = sliceLimits(input);
    expect(limits.map((limit) => limit.keys)).toEqual([['L', 'src_c', 'src_storage_mb_t']]);
    const most = Number(/L can be at most ([\d,]+)/.exec(limits[0]!.detail)![1]!.replaceAll(',', ''));
    const fits = { ...input, L: most };
    expect(fits.src_init_t + sourceDuration(fits)).toBeLessThanOrEqual(handlerTimeouts.source);
    const over = { ...input, L: most + 1 };
    expect(over.src_init_t + sourceDuration(over)).toBeGreaterThan(handlerTimeouts.source);
  });

  it('flags a lead handler that runs past its timeout', () => {
    // A store of 20 ms cannot reach the timeout with the largest batch, so this handler stores slowly.
    const input = slice({ ld_batch: 10_000, ld_c: 1, ld_order_repository_store_t: 200 });
    expect(input.ld_init_t + leadDuration(input, input.ld_batch)).toBeGreaterThan(handlerTimeouts.lead);
    const limits = sliceLimits(input);
    expect(limits.map((limit) => limit.keys)).toEqual([['ld_batch', 'ld_c']]);
    expect(limits[0]?.detail).toContain('ld_batch can be at most 297');
    const fits = slice({ ld_batch: 297, ld_c: 1, ld_order_repository_store_t: 200 });
    expect(fits.ld_init_t + leadDuration(fits, 297)).toBeLessThanOrEqual(handlerTimeouts.lead);
    expect(sliceLimits(fits)).toEqual([]);
  });

  it('flags a batch whose tokens take longer than the timeout of a lead handler', () => {
    const limits = sliceLimits(slice({ ld_batch: 601 }));
    expect(limits.map((limit) => limit.keys)).toEqual([['ld_batch', 'ld_writes']]);
    expect(limits[0]?.title).toContain('60.1 s');
    expect(limits[0]?.detail).toContain('ld_batch can be at most 600');
    expect(sliceLimits(slice({ ld_batch: 600 }))).toEqual([]);
  });

  it('flags a stage cap that passes the order write limit', () => {
    const limits = sliceLimits(slice({ L_q_c: 201 }));
    expect(limits.map((limit) => limit.keys)).toEqual([['L_q_c', 'ld_writes']]);
    expect(limits[0]?.title).toContain('2,010 orders a second');
    expect(limits[0]?.detail).toContain('L_q_c can be at most 200');
    expect(limits[0]?.detail).toContain('ld_writes can be at most 9');
    expect(sliceLimits(slice({ L_q_c: 400, ld_writes: 5 }))).toEqual([]);
  });

  it('flags a lead batch over the SQS limit', () => {
    const limits = sliceLimits(slice({ S: 1, L: 10, lead_b: 200_000 }));
    expect(limits.map((limit) => limit.keys)).toEqual([['lead_b']]);
    expect(limits[0]?.detail).toContain('lead_b can be at most 104,857 bytes');
  });
});

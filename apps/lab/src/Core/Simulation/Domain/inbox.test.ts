import { describe, expect, it } from 'vitest';

import { inboxDuration, inboxPutWaves, inboxReadTime, inboxSpans, inboxTimeline, normalizeInboxInputs } from './inbox';
import { emailBytes, megabyteBytes } from './payloads';
import { inboxDefaults } from './testing/roundDefaults';
import { releasesOf, timeOf } from './timeline';

/** The inbox with latency only: empty workbooks, and no time per MB. */
const latency = { ...inboxDefaults, L: 0, row_b: 0, in_storage_mb_t: 0 };

/** Workbooks of exactly 1 MB, moved at 20 ms per MB. */
const sized = normalizeInboxInputs({ ...inboxDefaults, L: 1024, row_b: 1024, S: 25, in_c: 10, in_storage_mb_t: 20 });

describe('Inbox slice', () => {
  it('times one handler from its timings and its put waves', () => {
    expect(inboxDuration(latency)).toBe(500);
    expect(inboxPutWaves(latency)).toBe(1);
    expect(inboxPutWaves(normalizeInboxInputs({ ...latency, S: 25, in_c: 10 }))).toBe(3);
    expect(inboxDuration(normalizeInboxInputs({ ...latency, S: 0 }))).toBe(380);
  });

  it('keeps the scale-up rate at zero or more and the start at one or more', () => {
    expect(normalizeInboxInputs({ ...inboxDefaults, esm_rate: -5 }).esm_rate).toBe(0);
    expect(normalizeInboxInputs({ ...inboxDefaults, esm_start: 0 }).esm_start).toBe(1);
    expect(normalizeInboxInputs({ ...inboxDefaults, in_init_t: -1 }).in_init_t).toBe(0);
  });

  it('splits one handler into acknowledge, get, parse, count, put, end, and delete', () => {
    expect(
      inboxSpans(latency).map(({ tone, symbol, name, call, start, end, amount }) => ({
        tone,
        symbol,
        name,
        call,
        start,
        end,
        amount,
      }))
    ).toEqual([
      {
        tone: 'ledger',
        symbol: 'in_request_ledger_acknowledge_t',
        name: 'RequestLedger.acknowledge',
        call: 'RequestLedger.acknowledge',
        start: 0,
        end: 20,
        amount: undefined,
      },
      {
        tone: 'get',
        symbol: 'in_storage_read_t',
        name: 'Storage.read',
        call: 'Storage.read',
        start: 20,
        end: 220,
        amount: undefined,
      },
      {
        tone: 'parse',
        symbol: 'in_email_parser_parse_t',
        name: 'EmailParser.parse',
        call: 'EmailParser.parse',
        start: 220,
        end: 300,
        amount: undefined,
      },
      {
        tone: 'ledger',
        symbol: 'in_request_ledger_record_t',
        name: 'RequestLedger.record',
        call: 'RequestLedger.record',
        start: 300,
        end: 320,
        amount: undefined,
      },
      {
        tone: 'put',
        symbol: 'in_storage_store_t',
        name: 'Storage.store',
        call: 'Storage.store',
        start: 320,
        end: 440,
        amount: 10,
      },
      {
        tone: 'ledger',
        symbol: 'in_request_ledger_record_t',
        name: 'RequestLedger.record',
        call: 'RequestLedger.record',
        start: 440,
        end: 460,
        amount: undefined,
      },
      {
        tone: 'delete',
        symbol: 'in_storage_delete_t',
        name: 'Storage.delete',
        call: 'Storage.delete',
        start: 460,
        end: 500,
        amount: undefined,
      },
    ]);
  });

  it('names each put and gives the last one fewer sources', () => {
    const input = normalizeInboxInputs({ ...latency, S: 25, in_c: 10 });
    expect(
      inboxSpans(input)
        .filter((span) => span.tone === 'put')
        .map((span) => [span.name, span.start, span.end, span.amount])
    ).toEqual([
      ['Storage.store', 320, 440, 10],
      ['Storage.store', 440, 560, 10],
      ['Storage.store', 560, 680, 5],
    ]);
  });

  it('omits a timing that takes no time', () => {
    const input = normalizeInboxInputs({
      ...latency,
      S: 0,
      in_email_parser_parse_t: 0,
      in_request_ledger_acknowledge_t: 0,
      in_request_ledger_record_t: 0,
    });
    expect(inboxSpans(input).map((span) => span.tone)).toEqual(['get', 'delete']);
  });

  it('adds the bytes each S3 call moves, and lets the puts of one wave share the network', () => {
    const email = Math.round((emailBytes(sized) / megabyteBytes) * 20);
    expect(inboxReadTime(sized)).toBe(200 + email);
    expect(
      inboxSpans(sized)
        .filter((span) => span.tone === 'put')
        .map((span) => [span.end - span.start, span.amount])
    ).toEqual([
      [120 + 10 * 20, 10],
      [120 + 10 * 20, 10],
      [120 + 5 * 20, 5],
    ]);
    const firstPut = inboxSpans(sized).find((span) => span.tone === 'put')!.start;
    expect(releasesOf(inboxTimeline(sized)).map(({ at, amount }) => [at - firstPut, amount])).toEqual([
      [320, 10],
      [640, 10],
      [860, 5],
    ]);
    expect(inboxDuration(sized)).toBe(20 + 200 + email + 80 + 20 + 860 + 20 + 40);
  });

  it('releases the sources where the put bars end, after the rounding of each wave', () => {
    const input = normalizeInboxInputs({ ...sized, row_b: 1000 });
    const puts = inboxSpans(input).filter((span) => span.tone === 'put');
    expect(releasesOf(inboxTimeline(input)).map((release) => release.at)).toEqual(puts.map((span) => span.end));
  });

  it('draws INIT first on a cold handler and moves every step after it', () => {
    const spans = inboxSpans(latency, 400);
    expect(spans[0]).toMatchObject({ tone: 'init', symbol: 'in_init_t', call: 'Lambda INIT', start: 0, end: 400 });
    expect(spans.slice(1).map((span) => span.start - 400)).toEqual(inboxSpans(latency).map((span) => span.start));
  });

  it('records the attachments before the first put and the end after the last put', () => {
    const records = inboxSpans(latency).filter((span) => span.symbol === 'in_request_ledger_record_t');
    const puts = inboxSpans(latency).filter((span) => span.tone === 'put');
    expect(records.map((span) => span.end)).toEqual([puts[0]!.start, puts.at(-1)!.end + 20]);
    expect(records[0]!.detail).toContain('10 attachments');
  });

  it('keeps the latency alone when the handler moves no bytes', () => {
    const input = { ...sized, L: 0 };
    expect(timeOf(inboxTimeline(input), 'put')).toBe(360);
    expect(inboxReadTime({ ...sized, in_storage_mb_t: 0 })).toBe(200);
  });
});

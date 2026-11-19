import { sesChunksOf } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';
import { describe, expect, it } from 'vitest';

import { emailCharges } from './emailCharges';
import { inboxDuration, inboxMemory } from './inbox';
import { inboxLogBytes, logIngestCost, logLineBytes, logStorageCost } from './logs';
import { base64Bytes, emailBytes, emailHeaderBytes } from './payloads';
import { scheduleInbox } from './schedule';
import { normalizeSliceInputs } from './sources';
import { sliceDefaults } from './testing/roundDefaults';

const oneHandler = (duration: number, sources: number) =>
  prices.lambdaRequest +
  (duration / 1000) * (inboxMemory / 1024) * prices.lambdaGbSecond +
  prices.s3Get +
  sources * prices.s3Put +
  logIngestCost(inboxLogBytes()) +
  logStorageCost(inboxLogBytes());

const arrival = (bytes: number) => prices.sesEmail + sesChunksOf(bytes) * prices.sesChunk + prices.s3Put;

/** Three writes of the request entry: the acknowledgement, the attachment count, and the end. One unit each. */
const ledger = 3 * prices.dynamoWriteUnit;

/** INIT at the GB-second price, and the INIT log lines that a new environment writes. */
const coldStart = (init: number) =>
  (init / 1000) * (inboxMemory / 1024) * prices.lambdaGbSecond +
  logIngestCost(logLineBytes.coldStart) +
  logStorageCost(logLineBytes.coldStart);

/** Ten emails with small attachments, so that SES can store the email. */
const small = (overrides: Partial<typeof sliceDefaults> = {}) =>
  normalizeSliceInputs({ ...sliceDefaults, E: 10, L: 100, ...overrides });

describe('Email charges', () => {
  it('sizes one email as its headers and its base64 workbooks', () => {
    expect(base64Bytes(3)).toBe(4 + 2);
    expect(base64Bytes(57)).toBe(76 + 2);
    expect(base64Bytes(58)).toBe(80 + 4);
    expect(emailBytes(small())).toBe(emailHeaderBytes + 10 * base64Bytes(100 * sliceDefaults.row_b));
    expect(emailBytes(small({ S: 0 }))).toBe(emailHeaderBytes);
  });

  it('prices one email on a warm environment, then every email and every cold start', () => {
    const input = small();
    const schedule = scheduleInbox(input);
    const charges = emailCharges(input, schedule);
    const duration = inboxDuration(input);
    const handler = oneHandler(duration, input.S);
    const bytes = emailBytes(input);

    expect(charges.lines.map((line) => line.label)).toEqual([
      'Email arrival',
      'Email consumption',
      'Handlers',
      'Ledger writes',
      'Cold starts',
    ]);
    expect(charges.lines[0]?.warning).toBeUndefined();
    expect(charges.lines[0]?.pure).toMatchObject({
      value: arrival(bytes),
      substitution: `$0.0001\n+ ${sesChunksOf(bytes)} × $0.00009\n+ 1 × $0.000005`,
    });
    expect(charges.lines[1]?.warning).toContain(
      'Consumption for these 10 emails would go from 30 requests ($0.000012) to 12 ($0.0000048)'
    );
    expect(charges.lines[1]?.pure.value).toBeCloseTo(3 * prices.sqsRequest, 15);
    expect(charges.lines[2]?.pure.substitution).toContain('10 × $0.000005');
    expect(charges.lines[2]?.pure.value).toBe(handler);
    expect(charges.lines[2]?.applied.value).toBe(input.E * handler);
    expect(charges.lines[2]?.time).toMatchObject({
      value: schedule.inbox.end - input.delay_in,
      formula: 'last inbox bar end − delay_in',
    });
    expect(charges.lines[3]?.time).toMatchObject({
      value: input.in_request_ledger_acknowledge_t + 2 * input.in_request_ledger_record_t,
      substitution: '20 + 2 × 20 ms',
    });
    expect(charges.lines[3]?.pure).toMatchObject({
      value: ledger,
      services: { DynamoDB: ledger },
      substitution: '3 × 1 × $0.00000067',
    });
    expect(charges.lines[3]?.applied.value).toBeCloseTo(input.E * ledger, 15);
    expect(charges.lines[4]?.time.value).toBe(input.in_init_t);
    expect(charges.lines[4]?.pure.value).toBe(coldStart(input.in_init_t));
    expect(charges.lines[4]?.applied.value).toBe(schedule.inbox.environments * coldStart(input.in_init_t));
    expect(charges.time).toMatchObject({ value: schedule.inbox.end, formula: 'last inbox bar end' });
    expect(charges.pure.value).toBeCloseTo(arrival(bytes) + 3 * prices.sqsRequest + handler + ledger, 15);
    expect(charges.pure.services.DynamoDB).toBeCloseTo(ledger, 15);
    expect(charges.applied.value).toBeCloseTo(
      input.E * charges.pure.value + schedule.inbox.environments * coldStart(input.in_init_t),
      15
    );
  });

  it('times a warm, scaled burst as one wave of T', () => {
    const input = small({ esm_start: 50, in_init_t: 0 });
    const schedule = scheduleInbox(input);
    const charges = emailCharges(input, schedule);
    expect(charges.lines[2]?.time.value).toBe(inboxDuration(input));
    expect(charges.lines[4]?.applied.services.Lambda).toBe(0);
    expect(charges.lines[4]?.applied.value).toBe(schedule.inbox.environments * coldStart(0));
    expect(charges.time.value).toBe(input.delay_in + inboxDuration(input));
  });

  it('warns that SES does not store an email over 40 MB', () => {
    const charges = emailCharges(normalizeSliceInputs({ ...sliceDefaults, L: 100_000 }));
    expect(charges.lines[0]?.warning).toContain('SES does not store an email larger than 40 MB in S3');
    expect(charges.lines[0]?.warning).toContain('10 workbooks of 100,000 rows');
  });

  it('drops attachment puts when an email has no sources', () => {
    const input = small({ E: 2, S: 0, delay_in: 0 });
    const handler = emailCharges(input).lines[2];
    expect(
      handler?.time.substitution.startsWith(
        'T = 20 + 200 + 0 MB × 20 + 80 + 20 + 0 × 120 + 0 × 0.03 MB × 20 + 20 + 40 ms'
      )
    ).toBe(true);
    expect(handler?.pure.value).toBe(oneHandler(inboxDuration(input), 0));
    expect(handler?.applied.value).toBe(2 * oneHandler(inboxDuration(input), 0));
  });
});

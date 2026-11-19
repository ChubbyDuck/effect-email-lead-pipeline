import { describe, expect, it } from 'vitest';

import {
  addSplits,
  billedSeconds,
  gbSecondsOf,
  gigabytesOf,
  memoryGb,
  scaleSplit,
  services,
  sesChunksOf,
  splitShares,
} from './billing';

describe('Billing rules', () => {
  it('bills a GB as 2^30 bytes', () => {
    expect(gigabytesOf(1024 ** 3)).toBe(1);
    expect(gigabytesOf(512 * 1024 ** 2)).toBe(0.5);
  });

  it('bills Lambda by each started ms, at the memory in GB of 1024 MB', () => {
    expect(billedSeconds(1500)).toBe(1.5);
    expect(billedSeconds(0.2)).toBe(0.001);
    expect(billedSeconds(0)).toBe(0);
    expect(memoryGb(512)).toBe(0.5);
    expect(gbSecondsOf(1000.4, 2048)).toBeCloseTo(2.002, 12);
  });

  it('bills each started SES chunk of 256 KB, and at least one', () => {
    expect(sesChunksOf(0)).toBe(1);
    expect(sesChunksOf(1)).toBe(1);
    expect(sesChunksOf(256 * 1024)).toBe(1);
    expect(sesChunksOf(256 * 1024 + 1)).toBe(2);
  });
});

describe('Service splits', () => {
  it('lists the services in one fixed order', () => {
    expect(services).toEqual(['Lambda', 'S3', 'SQS', 'SES', 'DynamoDB', 'CloudWatch Logs']);
  });

  it('adds and scales by service, in the fixed order', () => {
    expect(addSplits({ Lambda: 1, S3: 2 }, { S3: 3, SQS: 4 })).toEqual({ Lambda: 1, S3: 5, SQS: 4 });
    expect(scaleSplit({ Lambda: 1, SES: 2 }, 3)).toEqual({ Lambda: 3, SES: 6 });
    expect(splitShares({ SQS: 1, Lambda: 3, DynamoDB: 0 })).toEqual([
      { service: 'Lambda', cost: 3, share: 0.75 },
      { service: 'SQS', cost: 1, share: 0.25 },
    ]);
    expect(splitShares({})).toEqual([]);
  });
});

import { prices } from '@leads/shared/domain/prices';
import { describe, expect, it } from 'vitest';

import { burstCharges } from './burstCharges';
import {
  inboxLogBytes,
  leadLogBytes,
  logCost,
  logIngestCost,
  logLineBytes,
  logStorageCost,
  sourceLogBytes,
} from './logs';
import { sliceDefaults } from './sources';

describe('Log bytes', () => {
  it('counts the lines of the runs of a request with three sources of five leads', () => {
    // The real runs of `ntls5k1165jcg1a8otpg8kcqrsva6q18lk7ond81` logged these lines, each within 25 bytes of the model.
    expect(inboxLogBytes()).toBe(logLineBytes.platform + logLineBytes.emailSize + 2 * logLineBytes.progress);
    expect(sourceLogBytes({ L: 5 })).toBe(logLineBytes.platform + logLineBytes.sourceSize + 3 * logLineBytes.progress);
    expect(leadLogBytes(sliceDefaults, 8)).toBe(logLineBytes.platform + 2 * logLineBytes.progress);
  });

  it('logs no line for the leads of a source without leads', () => {
    expect(sourceLogBytes({ L: 0 })).toBe(logLineBytes.platform + logLineBytes.sourceSize + 2 * logLineBytes.progress);
  });

  it('writes a start and an end line for each request in a lead batch', () => {
    expect(leadLogBytes({ ...sliceDefaults, ld_requests: 3 }, 10)).toBe(
      logLineBytes.platform + 6 * logLineBytes.progress
    );
  });

  it('bills the bytes at the ingest price of a GB of 2^30 bytes', () => {
    expect(logIngestCost(1024 ** 3)).toBe(prices.logIngestGb);
  });

  it('bills one month of storage for the bytes, on top of the ingest', () => {
    expect(logStorageCost(1024 ** 3)).toBe(prices.logStorageGbMonth);
    expect(logCost(1024 ** 3)).toBe(prices.logIngestGb + prices.logStorageGbMonth);
  });

  it('bills the log lines of each stage as CloudWatch Logs', () => {
    const burst = burstCharges(sliceDefaults);
    for (const line of burst.lines) expect(line.applied.services['CloudWatch Logs']).toBeGreaterThan(0);
  });
});

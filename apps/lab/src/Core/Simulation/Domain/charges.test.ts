import { services } from '@leads/shared/domain/billing';
import { describe, expect, it } from 'vitest';

import { burstCharges, stackTotal } from './burstCharges';
import type { Charges, PriceFigure } from './charges';
import { emailCharges } from './emailCharges';
import { idleCharges } from './idleCharges';
import { leadCharges } from './leadCharges';
import { monthlyBursts } from './month';
import { scheduleSlice } from './schedule';
import { sourceCharges } from './sourceCharges';
import { sliceDefaults, type SliceInputs } from './sources';

const splitSum = (figure: PriceFigure) => services.reduce((sum, service) => sum + (figure.services[service] ?? 0), 0);

const chargePrices = (charges: Charges) => [
  ...charges.lines.flatMap((line) => [line.pure, line.applied]),
  charges.pure,
  charges.applied,
];

describe('Service splits of the charges', () => {
  it.each<[string, Partial<SliceInputs>]>([
    ['the defaults', {}],
    ['emails with no sources', { S: 0 }],
    ['sources with no leads', { L: 0 }],
    ['partial lead batches', { L: 25, ld_batch: 10 }],
    ['four bursts a day', { N: 4, E: 7 }],
  ])('splits every price into services that add up to it, for %s', (_, change) => {
    const input = { ...sliceDefaults, ...change };
    const schedule = scheduleSlice(input);
    const burst = burstCharges(input, schedule);
    const idle = idleCharges();
    const figures = [
      ...chargePrices(emailCharges(input, schedule)),
      ...chargePrices(sourceCharges(input, schedule)),
      ...chargePrices(leadCharges(input, schedule)),
      ...chargePrices(burst),
      ...idle.lines.map((line) => line.cost),
      idle.cost,
      stackTotal(input, burst, idle).cost,
    ];
    // Floating sums in a different order differ in the last digits only.
    for (const figure of figures)
      expect(Math.abs(splitSum(figure) - figure.value)).toBeLessThanOrEqual(1e-9 * Math.abs(figure.value));
  });

  it('bills the month to the services that run it', () => {
    const input = sliceDefaults;
    const burst = burstCharges(input);
    const idle = idleCharges();
    const total = stackTotal(input, burst, idle);
    const bursts = monthlyBursts(input);
    expect(total.cost.services.SQS).toBeCloseTo(bursts * (burst.applied.services.SQS ?? 0) + idle.cost.value, 12);
    expect(total.cost.services.S3).toBeCloseTo(bursts * (burst.applied.services.S3 ?? 0), 12);
    expect(total.cost.services.SES).toBeCloseTo(bursts * (burst.applied.services.SES ?? 0), 12);
    expect(total.cost.services.DynamoDB).toBeGreaterThan(0);
    expect(total.cost.services.Lambda).toBeGreaterThan(0);
  });
});

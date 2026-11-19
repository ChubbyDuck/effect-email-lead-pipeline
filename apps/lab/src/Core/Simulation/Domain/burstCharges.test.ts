import { services } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';
import { describe, expect, it } from 'vitest';

import { burstCharges, stackTotal } from './burstCharges';
import { emailCharges } from './emailCharges';
import { idleCharges, idlePollers, pollWaitSeconds, polledQueues } from './idleCharges';
import { leadCharges } from './leadCharges';
import { logCost, logLineBytes } from './logs';
import { monthDays } from './month';
import { scheduleSlice } from './schedule';
import { sourceCharges } from './sourceCharges';
import { sliceDefaults } from './sources';

describe('Burst charges', () => {
  it('ends the burst at the latest clock and adds all three bills', () => {
    const schedule = scheduleSlice(sliceDefaults);
    const burst = burstCharges(sliceDefaults, schedule);
    const inbox = emailCharges(sliceDefaults, schedule);
    const sources = sourceCharges(sliceDefaults, schedule);
    const leads = leadCharges(sliceDefaults, schedule);
    expect(burst.lines.map((line) => line.label)).toEqual(['Inbox', 'Sources', 'Leads']);
    expect(burst.time.value).toBe(Math.max(schedule.inbox.end, schedule.sources.end, schedule.leads.end));
    expect(burst.time.value).toBe(schedule.leads.end);
    const leadPure = ((sliceDefaults.S * sliceDefaults.L) / sliceDefaults.ld_batch) * leads.pure.value;
    expect(burst.pure.value).toBeCloseTo(inbox.pure.value + sliceDefaults.S * sources.pure.value + leadPure, 15);
    expect(burst.applied.value).toBeCloseTo(inbox.applied.value + sources.applied.value + leads.applied.value, 15);
  });

  it('costs every email as one warm email and the INIT log lines when INIT takes no time', () => {
    // A new lead environment does not wait for tokens and a warm one does, so this holds only with room to spare.
    const input = { ...sliceDefaults, L: 100, in_init_t: 0, src_init_t: 0, ld_init_t: 0, ld_writes: 1_000_000 };
    const schedule = scheduleSlice(input);
    const burst = burstCharges(input, schedule);
    const environments = schedule.inbox.environments + schedule.sources.environments + schedule.leads.environments;
    expect(burst.applied.value).toBeCloseTo(
      input.E * burst.pure.value + environments * logCost(logLineBytes.coldStart),
      15
    );
  });

  it('costs only the inbox when emails carry no sources', () => {
    const input = { ...sliceDefaults, S: 0 };
    const schedule = scheduleSlice(input);
    const burst = burstCharges(input, schedule);
    expect(burst.applied.value).toBeCloseTo(emailCharges(input, schedule).applied.value, 15);
    expect(burst.time.value).toBe(schedule.inbox.end);
  });
});

describe('Idle polling', () => {
  it('bills the empty receives of every polled queue for a month', () => {
    const idle = idleCharges();
    const requests = idlePollers * ((30 * 86_400) / pollWaitSeconds);
    expect(requests).toBe(648_000);
    expect(idle.lines.map((line) => line.label)).toEqual([...polledQueues]);
    expect(idle.lines[0]?.cost.value).toBeCloseTo(requests * prices.sqsRequest, 12);
    expect(idle.cost.value).toBeCloseTo(3 * requests * prices.sqsRequest, 12);
  });
});

describe('Stack total', () => {
  it('adds N bursts a day for a month and one month of idle polling', () => {
    const input = { ...sliceDefaults, N: 4 };
    const bursts = 4 * monthDays;
    const schedule = scheduleSlice(input);
    const burst = burstCharges(input, schedule);
    const idle = idleCharges();
    const total = stackTotal(input, burst, idle);
    expect(total.bursts).toBe(bursts);
    expect(total.parts.map((part) => part.label)).toEqual(['Inbox', 'Sources', 'Leads', 'Idle polling']);
    expect(total.parts.map((part) => part.cost)).toEqual([
      bursts * emailCharges(input, schedule).applied.value,
      bursts * sourceCharges(input, schedule).applied.value,
      bursts * leadCharges(input, schedule).applied.value,
      idle.cost.value,
    ]);
    expect(total.cost.value).toBeCloseTo(bursts * burst.applied.value + idle.cost.value, 12);
    expect(total.time).toBe(burst.time);
  });

  it('shares the monthly price over the bursts of the month', () => {
    const input = { ...sliceDefaults, N: 4 };
    const burst = burstCharges(input);
    const idle = idleCharges();
    const total = stackTotal(input, burst, idle);
    expect(total.perBurst).toBeCloseTo(total.cost.value / total.bursts, 12);
    expect(total.perBurst).toBeCloseTo(burst.applied.value + idle.cost.value / total.bursts, 12);
  });

  it('splits one burst by service as the month splits, over its bursts', () => {
    const input = { ...sliceDefaults, N: 4 };
    const total = stackTotal(input, burstCharges(input), idleCharges());
    for (const service of services)
      expect(total.perBurstServices[service] ?? 0).toBeCloseTo((total.cost.services[service] ?? 0) / total.bursts, 15);
    const perBurst = services.reduce((sum, service) => sum + (total.perBurstServices[service] ?? 0), 0);
    expect(perBurst).toBeCloseTo(total.perBurst, 12);
  });

  it('does not change idle polling with the bursts each day', () => {
    const idle = idleCharges();
    const one = stackTotal(sliceDefaults, burstCharges(sliceDefaults), idle);
    const input = { ...sliceDefaults, N: 2 };
    const two = stackTotal(input, burstCharges(input), idle);
    expect(two.cost.value - idle.cost.value).toBeCloseTo(2 * (one.cost.value - idle.cost.value), 12);
  });

  it('costs only idle polling when no email arrives', () => {
    const input = { ...sliceDefaults, E: 0 };
    const idle = idleCharges();
    expect(stackTotal(input, burstCharges(input), idle).cost.value).toBeCloseTo(idle.cost.value, 12);
  });
});

import { addSplits, scaleSplit, type ServiceSplit } from '@leads/shared/domain/billing';

import { dollars, figure, price, type ChargeLine, type Charges, type PriceFigure } from './charges';
import { emailCharges } from './emailCharges';
import { leadCharges } from './leadCharges';
import { leadsPerHandler } from './leads';
import { monthDays, monthlyBursts } from './month';
import { scheduleSlice, type SliceSchedule } from './schedule';
import { sourceCharges } from './sourceCharges';
import type { SliceInputs } from './sources';

/**
 * The whole burst on the shared clock: every email, every source those emails release, and every lead those sources push.
 * Each stage starts while the one before it still runs, so the burst ends at the latest of the three ends.
 * Pure price is one email with its S sources and their S × L leads, on warm environments. Applied price adds every cold start.
 */
export function burstCharges(input: SliceInputs, schedule: SliceSchedule = scheduleSlice(input)): Charges {
  const inbox = emailCharges(input, schedule);
  const sources = sourceCharges(input, schedule);
  const leads = leadCharges(input, schedule);
  const inboxEnd = schedule.inbox.end;
  const sourceEnd = schedule.sources.end;
  const leadEnd = schedule.leads.end;
  const sourcePure = input.S * sources.pure.value;
  const batch = leadsPerHandler(input);
  const leadsPerEmail = (input.S * input.L) / batch;
  const leadPure = leadsPerEmail * leads.pure.value;
  const sourcePureSplit = scaleSplit(sources.pure.services, input.S);
  const leadPureSplit = scaleSplit(leads.pure.services, leadsPerEmail);
  const lines: ChargeLine[] = [
    {
      label: 'Inbox',
      detail: 'Email arrival, email consumption, the inbox handlers, and their cold starts, from the table above.',
      time: figure(inboxEnd, 'last inbox bar end', `${inboxEnd} ms`),
      pure: price(inbox.pure.value, 'one email', dollars(inbox.pure.value), inbox.pure.services),
      applied: price(
        inbox.applied.value,
        'E emails + cold starts',
        dollars(inbox.applied.value),
        inbox.applied.services
      ),
    },
    {
      label: 'Sources',
      detail: 'Source consumption, the source handlers, and their cold starts. One email releases S sources.',
      time: figure(sourceEnd, 'last source bar end', `${sourceEnd} ms`),
      pure: price(sourcePure, 'S × one source', `${input.S} × ${dollars(sources.pure.value)}`, sourcePureSplit),
      applied: price(
        sources.applied.value,
        'E × S sources + cold starts',
        dollars(sources.applied.value),
        sources.applied.services
      ),
    },
    {
      label: 'Leads',
      detail: `Lead consumption, the lead handlers, and their cold starts. One email releases S × L leads, in batches of ${batch}.`,
      time: figure(leadEnd, 'last lead bar end', `${leadEnd} ms`),
      pure: price(
        leadPure,
        'S × L / ld_batch × one batch',
        `${input.S} × ${input.L} / ${batch} × ${dollars(leads.pure.value)}`,
        leadPureSplit
      ),
      applied: price(
        leads.applied.value,
        'every batch + cold starts',
        dollars(leads.applied.value),
        leads.applied.services
      ),
    },
  ];
  const end = Math.max(inboxEnd, sourceEnd, leadEnd);
  return {
    lines,
    time: figure(end, 'max(inbox end, source end, lead end)', `max(${inboxEnd}, ${sourceEnd}, ${leadEnd}) ms`),
    pure: price(
      inbox.pure.value + sourcePure + leadPure,
      'inbox + sources + leads',
      `${dollars(inbox.pure.value)} + ${dollars(sourcePure)} + ${dollars(leadPure)}`,
      addSplits(inbox.pure.services, sourcePureSplit, leadPureSplit)
    ),
    applied: price(
      inbox.applied.value + sources.applied.value + leads.applied.value,
      'inbox + sources + leads',
      `${dollars(inbox.applied.value)} + ${dollars(sources.applied.value)} + ${dollars(leads.applied.value)}`,
      addSplits(inbox.applied.services, sources.applied.services, leads.applied.services)
    ),
  };
}

export interface StackTotal {
  /** Bursts in the month: N bursts a day for 30 days. */
  bursts: number;
  /** The monthly price of each part, in the order they add up. */
  parts: readonly { label: string; cost: number }[];
  /** The monthly price, split by the AWS services that bill it. */
  cost: PriceFigure;
  /** The monthly price shared over the bursts: one burst at its applied price plus its share of idle polling. */
  perBurst: number;
  /** The price of one burst, split by the AWS services that bill it, in the same way as `perBurst`. */
  perBurstServices: ServiceSplit;
  time: ChargeLine['time'];
}

/**
 * Everything the stack bills in one month: N bursts a day for 30 days, each at its applied price,
 * plus one month of idle polling on the empty queues. The handlers delete each file they end, so no burst leaves storage.
 */
export function stackTotal(input: Pick<SliceInputs, 'N'>, burst: Charges, idle: { cost: PriceFigure }): StackTotal {
  const bursts = monthlyBursts(input);
  const stages = burst.lines.map((line) => ({ label: line.label, cost: bursts * line.applied.value }));
  const parts = [...stages, { label: 'Idle polling', cost: idle.cost.value }];
  const cost = parts.reduce((sum, part) => sum + part.cost, 0);
  const services = addSplits(scaleSplit(burst.applied.services, bursts), idle.cost.services);
  return {
    bursts,
    parts,
    perBurst: bursts > 0 ? cost / bursts : burst.applied.value,
    perBurstServices: bursts > 0 ? scaleSplit(services, 1 / bursts) : burst.applied.services,
    cost: price(
      cost,
      `N × 30 days × (${burst.lines.map((line) => line.label.toLowerCase()).join(' + ')}) + idle polling`,
      `${input.N} × ${monthDays} × (${burst.lines.map((line) => dollars(line.applied.value)).join(' + ')}) + ${dollars(idle.cost.value)}`,
      services
    ),
    time: burst.time,
  };
}

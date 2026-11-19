import { prices } from '@leads/shared/domain/prices';

import { dollars, figure, price, type Figure, type PriceFigure } from './charges';
import { monthDays } from './month';

/**
 * Pollers an SQS event source mapping keeps on an empty queue. An estimate: AWS documents five invocations
 * at low traffic, and does not lower them to two when the mapping has a maximum concurrency.
 */
export const idlePollers = 5;

/** Seconds one empty long poll waits before it returns. 20 s is the SQS maximum. An estimate. */
export const pollWaitSeconds = 20;

/** Queues of the stack that an event source mapping polls. The dead-letter queues have none. */
export const polledQueues = ['Inbox queue', 'Sources queue', 'Leads queue'] as const;

export interface IdleLine {
  label: string;
  detail: string;
  requests: Figure;
  cost: PriceFigure;
}

/** Empty receives while no message waits. This is a monthly cost of the stack, not a cost of one burst. */
export function idleCharges() {
  const polls = (monthDays * 24 * 3600) / pollWaitSeconds;
  const requests = idlePollers * polls;
  const cost = requests * prices.sqsRequest;
  const lines: IdleLine[] = polledQueues.map((label) => ({
    label,
    detail: `${idlePollers} pollers long-poll the empty queue. Each empty receive is one SQS request.`,
    requests: figure(
      requests,
      'pollers × (days × 86,400 s / wait)',
      `${idlePollers} × (${monthDays} × 86,400 / ${pollWaitSeconds})`
    ),
    cost: price(
      cost,
      'requests × $0.40 / 1,000,000',
      `${requests.toLocaleString('en-US')} × ${dollars(prices.sqsRequest)}`,
      {
        SQS: cost,
      }
    ),
  }));
  return {
    lines,
    requests: figure(
      lines.length * requests,
      'queues × requests',
      `${lines.length} × ${requests.toLocaleString('en-US')}`
    ),
    cost: price(lines.length * cost, 'queues × cost', `${lines.length} × ${dollars(cost)}`, {
      SQS: lines.length * cost,
    }),
  };
}

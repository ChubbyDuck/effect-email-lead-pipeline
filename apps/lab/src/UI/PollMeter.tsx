import { prices } from '@leads/shared/domain/prices';
import { cn } from '@leads/ui/lib/utils';

import { amount, fmt, money, rawDollars, time } from './format';
import { Formula } from './Formula';
import type { FeedState } from './requestFeed';

/** A value that flashes each time that its key changes. */
const Ticking = ({ tick, children }: { readonly tick: number; readonly children: string }) => (
  <span key={tick} className="tick font-semibold text-foreground">
    {children}
  </span>
);

/**
 * What the polls of this lab cost. Each poll scans the ledger, and DynamoDB tells the read units of each scan, so
 * the cost is exact.
 */
export function PollMeter({ feed }: { readonly feed: FeedState }) {
  const reads = feed.status?.reads;
  const paused = feed.connection === 'paused';

  return (
    <dl className="mb-4 rounded-xl border bg-background/50 px-4 py-3 text-xs text-muted-foreground">
      <div className="flex flex-col gap-0.5">
        <dt className="flex items-center gap-2 font-semibold text-foreground">
          <i className={cn('size-1.5 rounded-full', paused ? 'bg-muted-foreground/40' : 'bg-live')} />
          Ledger polls of this lab
          {paused && <span className="font-normal text-muted-foreground">paused</span>}
        </dt>
        <dd>
          {reads === undefined ? (
            paused ? (
              'No polls while the requests are paused.'
            ) : (
              'Waiting for the first poll.'
            )
          ) : (
            <>
              <Ticking tick={reads.polls}>{money(reads.readUnits * prices.dynamoReadUnit)}</Ticking> for{' '}
              {fmt(reads.polls)} polls and {amount(reads.readUnits)} read units since {time(reads.since)} ·{' '}
              {money(reads.lastReadUnits * prices.dynamoReadUnit)} for the last poll of {amount(reads.lastReadUnits)}{' '}
              units
              <Formula className="mt-0.5">
                = {amount(reads.readUnits)} read units × {rawDollars(prices.dynamoReadUnit)} · last poll{' '}
                {amount(reads.lastReadUnits)} × {rawDollars(prices.dynamoReadUnit)}
              </Formula>
            </>
          )}
        </dd>
      </div>
    </dl>
  );
}

import { prices } from '@leads/shared/domain/prices';
import { stageLabels } from '@leads/shared/domain/stages';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@leads/ui/components/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@leads/ui/components/table';
import { cn } from '@leads/ui/lib/utils';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  type CostLine,
  type CostOwner,
  costsBy,
  costsOf,
  type CostReport,
  lineFormula,
  monthHours,
  sumFormula,
} from '#Core/Observation/Domain/costs';
import type { Snapshot } from '#Core/Observation/Domain/snapshot';

import { amount, fmt, money, rawDollars } from './format';
import { Formula } from './Formula';
import { Panel, SectionView } from './Panel';
import { type FeedState, requestsInWindow } from './requestFeed';
import { useNow } from './useRequestFeed';

const ownerLabels: Record<CostOwner, string> = { ...stageLabels, shared: 'Request ledger' };

/**
 * What the stack cost in the window, at the list prices of the Region, and a month at the same rate. The usage comes
 * from CloudWatch, so a cost that CloudWatch does not count exactly shows how it was estimated.
 */
export function Costs({
  snapshot,
  windowHours,
  feed,
}: {
  readonly snapshot: Snapshot | undefined;
  readonly windowHours: number;
  /** The ledger gives the requests of the window, which share the cost of the work. */
  readonly feed: FeedState;
}) {
  const now = useNow(10_000);
  const requests = requestsInWindow(feed, windowHours, now).length;
  return (
    <Panel
      title="Costs"
      description={`The last ${windowHours} h at the list prices of ${prices.region}, without the free tier and taxes`}
    >
      <SectionView snapshot={snapshot} select={(loaded) => loaded.usage}>
        {(usage, loaded) => <Report report={costsOf(usage, loaded.windowHours)} requests={requests} />}
      </SectionView>
    </Panel>
  );
}

function Report({ report, requests }: { readonly report: CostReport; readonly requests: number }) {
  const idleShare = report.total > 0 ? report.idle / report.total : 0;
  const idlePolls = report.lines
    .filter(({ kind }) => kind === 'idle')
    .reduce((total, { quantity }) => total + quantity, 0);
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Figure
          label="In the window"
          value={money(report.total)}
          hint={`${plural(report.lines.length, 'cost line')}`}
          formula={`= work ${money(report.work)} + idle ${money(report.idle)} + monitor ${money(report.monitor)}`}
        />
        <Figure
          label="A month at this rate"
          value={money(report.perMonth)}
          hint={`with ${money(report.storageTotal)} of storage`}
          formula={`= ${money(report.total)} × ${monthHours} h ÷ ${report.windowHours} h + ${money(report.storageTotal)}`}
        />
        <Figure
          label="Each request"
          value={requests > 0 ? money(report.work / requests) : '–'}
          hint={
            requests > 0
              ? `the work of ${plural(requests, 'request')}, without polling and this lab`
              : 'no requests in the window'
          }
          formula={requests > 0 ? `= ${money(report.work)} ÷ ${plural(requests, 'request')}` : undefined}
        />
        <Figure
          label="Idle polling"
          value={money(report.idle)}
          hint={report.total > 0 ? `${Math.round(idleShare * 100)}% of the window` : 'none'}
          tone={idleShare >= 0.5 ? 'text-warn' : undefined}
          formula={`= ${amount(idlePolls)} empty polls × ${rawDollars(prices.sqsRequest)}`}
        />
      </dl>
      {report.total > 0 && (
        <div className="grid gap-6 md:grid-cols-2">
          <Shares title="By service" shares={costsBy(report.lines, (line) => line.service)} total={report.total} />
          <Shares
            title="By stage"
            shares={costsBy(report.lines, (line) => line.owner).map((share) => ({
              ...share,
              key: ownerLabels[share.key],
            }))}
            total={report.total}
          />
        </div>
      )}
      <Lines title="All costs of the window" lines={report.lines} />
      {report.storage.length > 0 && <Lines title="Storage, for each month" lines={report.storage} />}
      <p className="text-xs text-muted-foreground">
        Prices of {prices.readAt}. Not in the costs: data transfer, AppConfig, and the free tier. This lab read the
        ledger for {money(report.monitor)} in the window, and each refresh requests CloudWatch metrics for about{' '}
        {money(report.perRead)}.
      </p>
    </div>
  );
}

const plural = (count: number, one: string) => `${fmt(count)} ${count === 1 ? one : `${one}s`}`;

function Figure({
  label,
  value,
  hint,
  tone,
  formula,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: ReactNode;
  readonly tone?: string | undefined;
  readonly formula?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border bg-background/50 px-4 py-3">
      <dt className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className={cn('text-xl font-extrabold tracking-tight', tone)}>{value}</dd>
      <dd className="text-xs text-muted-foreground">{hint}</dd>
      {formula !== undefined && (
        <dd>
          <Formula>{formula}</Formula>
        </dd>
      )}
    </div>
  );
}

/** The parts of the total, the largest first, each with a bar of its share. */
function Shares({
  title,
  shares,
  total,
}: {
  readonly title: string;
  readonly shares: readonly { readonly key: string; readonly cost: number; readonly parts: readonly number[] }[];
  readonly total: number;
}) {
  const largest = shares[0]?.cost ?? 0;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-extrabold">{title}</h3>
      <ul className="flex flex-col gap-2.5">
        {shares.map(({ key, cost, parts }) => (
          <li key={key} className="grid grid-cols-[8.5rem_1fr_5.5rem] items-center gap-3 text-sm">
            <span className="truncate">{key}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-foreground/55"
                style={{ width: `${largest > 0 ? (cost / largest) * 100 : 0}%` }}
              />
            </span>
            <span className="text-right" title={`${Math.round((cost / total) * 100)}% of the window`}>
              {money(cost)}
            </span>
            <Formula className="col-span-3 -mt-1.5 text-right">= {sumFormula(parts)}</Formula>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Lines({ title, lines }: { readonly title: string; readonly lines: readonly CostLine[] }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1.5 text-sm font-semibold outline-none hover:text-primary focus-visible:text-primary">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        {title}
        <span className="font-normal text-muted-foreground">{fmt(lines.length)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="text-muted-foreground">Stage</TableHead>
              <TableHead className="text-muted-foreground">Service</TableHead>
              <TableHead className="text-muted-foreground">Item</TableHead>
              <TableHead className="text-right text-muted-foreground">Quantity</TableHead>
              <TableHead className="text-right text-muted-foreground">Unit price</TableHead>
              <TableHead className="text-right text-muted-foreground">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.map((line, index) => (
              <TableRow key={index}>
                <TableCell>{ownerLabels[line.owner]}</TableCell>
                <TableCell>{line.service}</TableCell>
                <TableCell className="whitespace-normal">
                  {line.item}
                  {line.kind !== 'work' && (
                    <span
                      className={cn('ml-2 text-xs font-semibold', line.kind === 'idle' ? 'text-warn' : 'text-live')}
                    >
                      {line.kind}
                    </span>
                  )}
                  {line.note !== undefined && <span className="block text-xs text-muted-foreground">{line.note}</span>}
                </TableCell>
                <TableCell className="text-right">
                  {amount(line.quantity)} <span className="text-muted-foreground">{line.unit}</span>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{rawDollars(line.unitPrice)}</TableCell>
                <TableCell className="text-right">
                  <span className="font-semibold">{money(line.cost)}</span>
                  <Formula className="whitespace-nowrap">= {lineFormula(line)}</Formula>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}

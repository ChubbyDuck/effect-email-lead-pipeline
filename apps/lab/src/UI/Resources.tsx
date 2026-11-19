import { stageLabels } from '@leads/shared/domain/stages';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@leads/ui/components/collapsible';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@leads/ui/components/table';
import { cn } from '@leads/ui/lib/utils';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { lambdaPrice } from '#Core/Observation/Domain/costs';
import { type LogEvent, peak, type Snapshot, toolLabels, total } from '#Core/Observation/Domain/snapshot';

import { ago, bytes, countClass, dateTime, fmt, money, time } from './format';
import { Formula } from './Formula';
import { consoleLinks } from './links';
import { SectionView } from './Panel';
import { Spark } from './Spark';
import { Tag } from './Tag';

type Props = { readonly snapshot: Snapshot | undefined };

/** The last snapshot has the object lists of up to 1000 objects. The page shows only the newest. */
const objectsShown = 15;
/** The AWS source reads at most this many log events. */
export const logLimit = 100;

const Head = ({ right = false, children }: { readonly right?: boolean; readonly children?: ReactNode }) => (
  <TableHead className={cn('text-muted-foreground', right && 'text-right')}>{children}</TableHead>
);

/** A table of resources. The header row does not take the hover color. */
function ResourceTable({ head, children }: { readonly head: ReactNode; readonly children: ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">{head}</TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </Table>
  );
}

const Empty = ({ children }: { readonly children: ReactNode }) => (
  <p className="py-6 text-center text-muted-foreground">{children}</p>
);

export function Handlers({ snapshot }: Props) {
  return (
    <SectionView snapshot={snapshot} select={(loaded) => loaded.handlers}>
      {(handlers, loaded) => {
        const link = consoleLinks(loaded);
        return (
          <ResourceTable
            head={
              <>
                <Head>Stage</Head>
                <Head>Function</Head>
                <Head>State</Head>
                <Head right>Runs</Head>
                <Head right>Failed</Head>
                <Head right>Throttled</Head>
                <Head right>Longest run</Head>
                <Head right>Peak concurrency</Head>
                <Head>Runs and failures</Head>
                <Head right>Settings</Head>
                <Head>Deployed</Head>
              </>
            }
          >
            {handlers.map((handler) => {
              const errors = total(handler.errors);
              const throttles = total(handler.throttles);
              const healthy = handler.state === 'Active' && handler.mapping.state === 'Enabled';
              return (
                <TableRow key={handler.stage}>
                  <TableCell className="font-medium">{stageLabels[handler.stage]}</TableCell>
                  <TableCell>{link.fn(handler.functionName)}</TableCell>
                  <TableCell>
                    <Tag tone={healthy ? 'ok' : 'critical'}>
                      {handler.state}, trigger {handler.mapping.state.toLowerCase()}
                    </Tag>
                  </TableCell>
                  <TableCell className="text-right">{fmt(total(handler.invocations))}</TableCell>
                  <TableCell className={cn('text-right', countClass(errors, 'bad'))}>{fmt(errors)}</TableCell>
                  <TableCell className={cn('text-right', countClass(throttles, 'warn'))}>{fmt(throttles)}</TableCell>
                  <TableCell className="text-right">
                    {(peak(handler.durationMax) / 1000).toFixed(2)} s
                    <span className="block text-xs text-muted-foreground">
                      {money(lambdaPrice(peak(handler.durationMax), handler.memoryMb).cost)}
                    </span>
                    <Formula className="ml-auto max-w-56">
                      {lambdaPrice(peak(handler.durationMax), handler.memoryMb).formula}
                    </Formula>
                  </TableCell>
                  <TableCell className="text-right">{fmt(peak(handler.concurrencyMax))}</TableCell>
                  <TableCell>
                    <Spark series={handler.invocations} errors={handler.errors} className="w-40" />
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    {handler.memoryMb} MB, {handler.timeoutSeconds} s, batch {handler.mapping.batchSize}, max{' '}
                    {handler.mapping.maximumConcurrency ?? '–'}, reserved {handler.reservedConcurrency ?? '–'}
                  </TableCell>
                  <TableCell title={handler.lastModified}>{dateTime(handler.lastModified)}</TableCell>
                </TableRow>
              );
            })}
          </ResourceTable>
        );
      }}
    </SectionView>
  );
}

export function Queues({ snapshot }: Props) {
  return (
    <SectionView snapshot={snapshot} select={(loaded) => loaded.queues}>
      {(queues, loaded) => {
        const link = consoleLinks(loaded);
        return (
          <ResourceTable
            head={
              <>
                <Head>Stage</Head>
                <Head>Queue</Head>
                <Head>Role</Head>
                <Head right>Visible</Head>
                <Head right>In flight</Head>
                <Head right>Delayed</Head>
                <Head right>Oldest age</Head>
                <Head right>Sent</Head>
                <Head>Sent over time</Head>
                <Head right>Visibility timeout</Head>
              </>
            }
          >
            {queues.map((queue) => {
              const level = queue.role === 'dlq' ? 'bad' : 'warn';
              return (
                <TableRow key={queue.name}>
                  <TableCell className="font-medium">{stageLabels[queue.stage]}</TableCell>
                  <TableCell>{link.queue(queue)}</TableCell>
                  <TableCell>
                    {queue.role === 'dlq' ? (
                      <Tag tone="neutral">DLQ</Tag>
                    ) : (
                      <span className="text-muted-foreground">main</span>
                    )}
                  </TableCell>
                  <TableCell className={cn('text-right', countClass(queue.visible, level))}>
                    {fmt(queue.visible)}
                  </TableCell>
                  <TableCell className={cn('text-right', countClass(queue.inFlight, level))}>
                    {fmt(queue.inFlight)}
                  </TableCell>
                  <TableCell className="text-right">{fmt(queue.delayed)}</TableCell>
                  <TableCell className="text-right">
                    {queue.oldestAgeSeconds === undefined ? '–' : `${fmt(queue.oldestAgeSeconds)} s`}
                  </TableCell>
                  <TableCell className="text-right">{fmt(total(queue.sent))}</TableCell>
                  <TableCell>
                    <Spark series={queue.sent} className="w-40" />
                  </TableCell>
                  <TableCell className="text-right">{fmt(queue.visibilityTimeoutSeconds)} s</TableCell>
                </TableRow>
              );
            })}
          </ResourceTable>
        );
      }}
    </SectionView>
  );
}

export function Buckets({ snapshot }: Props) {
  return (
    <SectionView snapshot={snapshot} select={(loaded) => loaded.buckets}>
      {(buckets, loaded) => {
        const link = consoleLinks(loaded);
        const now = Date.parse(loaded.collectedAt);
        return (
          <div className="flex flex-col divide-y">
            {buckets.map((bucket) => {
              const newest = bucket.objects[0];
              const shown = bucket.objects.slice(0, objectsShown);
              return (
                <Collapsible key={bucket.name} className="group/bucket py-2 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <CollapsibleTrigger
                      className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                      aria-label={`Show the objects of ${bucket.name}`}
                    >
                      <ChevronRight className="size-4 transition-transform group-data-[state=open]/bucket:rotate-90 motion-reduce:transition-none" />
                    </CollapsibleTrigger>
                    <span className="font-medium">{link.bucket(bucket.name)}</span>
                    <span className="text-muted-foreground">waiting or failed:</span>
                    <span className={countClass(bucket.objects.length, 'warn')}>
                      {fmt(bucket.objects.length)}
                      {bucket.truncated && '+'}
                    </span>
                    {newest !== undefined && (
                      <span className="text-muted-foreground">(newest {ago(newest.lastModified, now)})</span>
                    )}
                  </div>
                  <CollapsibleContent className="pt-2 pl-8">
                    {shown.length > 0 ? (
                      <ResourceTable
                        head={
                          <>
                            <Head>Key</Head>
                            <Head right>Size</Head>
                            <Head>Modified</Head>
                          </>
                        }
                      >
                        {shown.map((object) => (
                          <TableRow key={object.key}>
                            <TableCell className="font-mono text-xs">{object.key}</TableCell>
                            <TableCell className="text-right">{bytes(object.size)}</TableCell>
                            <TableCell title={object.lastModified}>
                              {time(object.lastModified)}{' '}
                              <span className="text-muted-foreground">({ago(object.lastModified, now)})</span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </ResourceTable>
                    ) : (
                      <p className="text-muted-foreground">The bucket is empty.</p>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              );
            })}
          </div>
        );
      }}
    </SectionView>
  );
}

/** One log event. A click on the message shows all of it. */
function Log({ event }: { readonly event: LogEvent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Tag tone={event.level === 'error' ? 'critical' : 'warning'}>{event.level}</Tag>
        <span className="font-medium">{stageLabels[event.stage]}</span>
        <span className="text-muted-foreground" title={event.time}>
          {dateTime(event.time)}
        </span>
        {event.requestId !== undefined && (
          <code className="font-mono text-xs text-muted-foreground">{event.requestId}</code>
        )}
      </div>
      <button
        type="button"
        className={cn(
          'mt-2 block w-full cursor-pointer rounded-md bg-muted px-3 py-2 text-left font-mono text-xs leading-relaxed break-words whitespace-pre-wrap outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
          !open && 'max-h-[7.5em] overflow-hidden'
        )}
        title={open ? 'Click to collapse' : 'Click to expand'}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {event.message}
      </button>
    </div>
  );
}

export function Logs({ snapshot }: Props) {
  return (
    <SectionView snapshot={snapshot} select={(loaded) => loaded.logs}>
      {(events) =>
        events.length > 0 ? (
          <div className="flex flex-col divide-y">
            {events.length >= logLimit && (
              <p className="pb-3 text-muted-foreground">Only the newest {logLimit} events are shown.</p>
            )}
            {events.map((event, index) => (
              <Log key={`${event.time}:${index}`} event={event} />
            ))}
          </div>
        ) : (
          <Empty>No errors or warnings in the window.</Empty>
        )
      }
    </SectionView>
  );
}

export function RuntimeSettings({ snapshot }: Props) {
  return (
    <SectionView snapshot={snapshot} select={(loaded) => loaded.settings}>
      {({ environmentState, deployment, content }) => (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2">
            <dt className="text-muted-foreground">Environment</dt>
            <dd>
              <Tag tone={environmentState === 'ROLLED_BACK' ? 'critical' : 'neutral'}>{environmentState}</Tag>
            </dd>
            <dt className="text-muted-foreground">Deployment</dt>
            <dd className="flex flex-wrap items-center gap-2">
              {deployment === undefined ? (
                <span className="text-warn">none</span>
              ) : (
                <>
                  <span>
                    #{deployment.number} of version {deployment.version}
                  </span>
                  <Tag tone={deployment.state === 'COMPLETE' ? 'ok' : 'warning'}>{deployment.state}</Tag>
                  <span className="text-muted-foreground">started {dateTime(deployment.startedAt)}</span>
                </>
              )}
            </dd>
          </dl>
          {content !== undefined && (
            <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs leading-relaxed">
              {JSON.stringify(content, null, 2)}
            </pre>
          )}
        </div>
      )}
    </SectionView>
  );
}

const phaseTones = { complete: 'ok', 'in-progress': 'info', failed: 'critical' } as const;

/** The status of the deployment, as the IaC tool that made it keeps it. */
export function Stack({ snapshot }: Props) {
  return (
    <SectionView snapshot={snapshot} select={(loaded) => loaded.deploymentStatus}>
      {(stack) => (
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-2">
          <dt className="text-muted-foreground">Tool</dt>
          <dd>{toolLabels[stack.tool]}</dd>
          <dt className="text-muted-foreground">Name</dt>
          <dd className="font-medium">{stack.name}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <Tag tone={phaseTones[stack.phase]}>{stack.status}</Tag>
          </dd>
          <dt className="text-muted-foreground">Updated</dt>
          <dd>
            {stack.updatedAt === undefined ? (
              <span className="text-muted-foreground">unknown</span>
            ) : (
              dateTime(stack.updatedAt)
            )}
          </dd>
          {stack.reason !== undefined && (
            <>
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="text-muted-foreground">{stack.reason}</dd>
            </>
          )}
        </dl>
      )}
    </SectionView>
  );
}

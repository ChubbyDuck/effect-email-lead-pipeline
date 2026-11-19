import { stageLabels, stageNames, type StageName } from '@leads/shared/domain/stages';
import { Button } from '@leads/ui/components/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@leads/ui/components/collapsible';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@leads/ui/components/sheet';
import { cn } from '@leads/ui/lib/utils';
import { Check, ChevronRight, Copy, ExternalLink, RefreshCw, Snowflake } from 'lucide-react';
import { type ReactNode, Suspense, use, useDeferredValue, useState } from 'react';

import { type Priced, runPrice, timePrice } from '#Core/Observation/Domain/costs';
import { changedAfterRead, type DetailsResult, type RequestDetails, tallyOf } from '#Core/Observation/Domain/details';
import type { DeadLetterCounts } from '#Core/Observation/Domain/dlq';
import { type RequestView, waitingOf } from '#Core/Observation/Domain/requests';
import {
  type HandlerRun,
  type RequestRuns,
  type RunLine,
  runLineLimit,
  type StageRuns,
} from '#Core/Observation/Domain/runs';
import type { Section } from '#Core/Observation/Domain/snapshot';

import { ago, clock, duration, fmt, money, offset, time } from './format';
import { Formula } from './Formula';
import { runLogsUrl } from './links';
import { Loading, SectionError } from './Panel';
import { RequestCostView } from './RequestCost';
import { shownStateOf, stateText } from './requestFeed';
import { runStateOf, runStepsOf, type Step, stepsOf, type Timeline, timelineOf } from './runView';
import { Tag, toneFill, toneText } from './Tag';
import { useNow } from './useRequestFeed';

/** One read of the details of a request. A refresh makes a new read. */
export interface RunsRead {
  readonly requestID: string;
  readonly result: Promise<DetailsResult>;
}

const plural = (count: number, one: string, many = `${one}s`) => `${fmt(count)} ${count === 1 ? one : many}`;

/**
 * The details of one request in a sheet at the side of the page: a timeline of its Lambda runs, then one section for
 * each stage with a box for each run, and the log lines of each run in the box. The entry of the request stays live;
 * the runs load when the sheet opens and when the person refreshes them, because each read costs log requests.
 */
export function RequestSheet({
  request,
  deadLetters,
  read,
  open,
  onOpenChange,
  onRefresh,
}: {
  /** No request when the entry left the feed. */
  readonly request: RequestView | undefined;
  readonly deadLetters: DeadLetterCounts | undefined;
  readonly read: RunsRead | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefresh: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[880px]">
        {read !== undefined && (
          <Details
            key={read.requestID}
            requestID={read.requestID}
            request={request}
            deadLetters={deadLetters}
            read={read}
            onRefresh={onRefresh}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function Details({
  requestID,
  request,
  deadLetters,
  read,
  onRefresh,
}: {
  readonly requestID: string;
  readonly request: RequestView | undefined;
  readonly deadLetters: DeadLetterCounts | undefined;
  readonly read: RunsRead;
  readonly onRefresh: () => void;
}) {
  const now = useNow(1000);
  // While a refresh loads, the sheet keeps the last read.
  const shown = useDeferredValue(read.result);
  const loading = shown !== read.result;
  return (
    <>
      <SheetHeader className="gap-3 border-b px-5 py-5 pr-14 md:px-7">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Request</p>
            <SheetTitle className="mt-1 flex items-center gap-1.5 font-mono text-[15px] font-semibold break-all">
              {requestID}
              <CopyButton text={requestID} label="Copy the request ID" />
            </SheetTitle>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="flex-none rounded-lg"
            disabled={loading}
            onClick={onRefresh}
            title="Read the runs again"
          >
            <RefreshCw className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
            Refresh
          </Button>
        </div>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {request === undefined ? (
              <span>The entry is no longer in the window.</span>
            ) : (
              <EntrySummary request={request} deadLetters={deadLetters} now={now} />
            )}
          </div>
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto px-5 py-5 md:px-7">
        <Suspense fallback={<RunsLoading />}>
          <Settled promise={shown}>
            {(result) =>
              result.ok ? <Runs details={result.details} request={request} /> : <SectionError error={result.error} />
            }
          </Settled>
        </Suspense>
      </div>
    </>
  );
}

export function Settled<T>({
  promise,
  children,
}: {
  readonly promise: Promise<T>;
  readonly children: (value: T) => ReactNode;
}) {
  return children(use(promise));
}

function EntrySummary({
  request,
  deadLetters,
  now,
}: {
  readonly request: RequestView;
  readonly deadLetters: DeadLetterCounts | undefined;
  readonly now: number;
}) {
  const [tone, text] = stateText[shownStateOf(request, now, deadLetters)];
  const waiting = waitingOf(request, deadLetters);
  const inDlq = (waiting.inboxInDlq ? 1 : 0) + waiting.sourcesInDlq + waiting.leadsInDlq;
  const sources = `${fmt(request.sourcesProcessed)} / ${request.attachments === undefined ? '?' : fmt(request.attachments)}`;
  return (
    <>
      <Tag tone={tone}>{text}</Tag>
      {request.receivedAt !== undefined && <span title={request.receivedAt}>received {time(request.receivedAt)}</span>}
      <span title={request.updatedAt}>updated {ago(request.updatedAt, now)}</span>
      <span>sources {sources}</span>
      <span>
        leads {fmt(request.leadsProcessed)} / {fmt(request.sourcesLeads)}
      </span>
      {inDlq > 0 && <span className="font-semibold text-crit">{plural(inDlq, 'message')} in DLQ</span>}
    </>
  );
}

function RunsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-label="Loading the runs">
      <div className="h-28 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
      {stageNames.map((stage) => (
        <div key={stage} className="flex flex-col gap-3">
          <p className="font-extrabold">{stageLabels[stage]}</p>
          <Loading rows={2} />
        </div>
      ))}
    </div>
  );
}

/** The runs of the request in the details that the server read. `request` is the live entry of the feed. */
function Runs({ details, request }: { readonly details: RequestDetails; readonly request: RequestView | undefined }) {
  const [openLogs, setOpenLogs] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string>();
  const { runs, loaded, tally, cost, missing } = details;
  const { receivedAt } = details.entry;
  const timeline = timelineOf(loaded, receivedAt, Date.parse(runs.readAt));

  const toggleLogs = (runID: string, open: boolean) =>
    setOpenLogs((current) => {
      const next = new Set(current);
      if (open) next.add(runID);
      else next.delete(runID);
      return next;
    });

  /** A bar of the timeline opens the logs of its run and shows its box. */
  function pick(run: HandlerRun) {
    toggleLogs(run.runID, true);
    setFocused(run.runID);
    requestAnimationFrame(() =>
      document.getElementById(`run-${run.runID}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-base font-extrabold tracking-tight">Runs</h3>
          <p className="text-xs text-muted-foreground">
            {plural(tally.runs, 'run')}
            {tally.runs > 0 && (
              <>
                {' '}
                · {duration(tally.computeMs)} of compute · {money(tally.lambda.cost)} of Lambda
              </>
            )}
            {timeline !== undefined && <> · {duration(timeline.end - timeline.start)} end to end</>} · read at{' '}
            {time(runs.readAt)}
          </p>
          {tally.runs > 0 && <Formula className="basis-full">= {tally.lambda.formula}</Formula>}
        </div>
        {changedAfterRead(details, request) && (
          <p className="rounded-lg bg-live-soft px-3 py-2 text-xs text-live">
            The request changed after this read. Refresh to read its new runs.
          </p>
        )}
        {timeline === undefined ? (
          loaded.length === stageNames.length && <NoRuns />
        ) : (
          <RunTimeline timeline={timeline} receivedAt={receivedAt} focused={focused} onPick={pick} />
        )}
      </section>
      {tally.runs > 0 && <RequestCostView cost={cost} missing={missing} />}
      {stageNames.map((stage) => (
        <StageSection
          key={stage}
          stage={stage}
          section={runs.stages[stage]}
          place={runs}
          requestID={runs.requestID}
          receivedAt={receivedAt}
          openLogs={openLogs}
          focused={focused}
          onLogs={toggleLogs}
        />
      ))}
    </div>
  );
}

function NoRuns() {
  return (
    <div className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
      <p className="font-semibold text-foreground">No run in the logs names this request.</p>
      <p className="mt-1">
        A handler names the request in its logs only since it logs its progress writes, so a request from before that
        deploy has no runs here.
      </p>
    </div>
  );
}

/** In px. The height of the bars and of the gap between two rows of a lane. */
const barHeight = (rows: number) => Math.max(3, Math.min(10, Math.floor(44 / rows) - 2));
const rowGap = 3;

/**
 * The runs of the request on one axis of time, one lane for each stage. The gaps between the bars are the time that
 * the work waited in a queue. A bar opens the logs of its run.
 */
function RunTimeline({
  timeline,
  receivedAt,
  focused,
  onPick,
}: {
  readonly timeline: Timeline;
  readonly receivedAt: string | undefined;
  readonly focused: string | undefined;
  readonly onPick: (run: HandlerRun) => void;
}) {
  const length = timeline.end - timeline.start;
  const percent = (share: number) => `${(share * 100).toFixed(3)}%`;
  return (
    <figure className="rounded-xl border bg-background/60 px-4 pt-4 pb-3">
      <div className="grid grid-cols-[92px_1fr] items-center gap-x-3 gap-y-2.5">
        {timeline.lanes.map((lane) => {
          const height = barHeight(lane.rows);
          return (
            <div key={lane.stage} className="contents">
              <span className="text-xs font-semibold text-muted-foreground">{stageLabels[lane.stage]}</span>
              <div
                className="relative rounded-sm bg-muted/60"
                style={{ height: Math.max(lane.rows * (height + rowGap) + rowGap, 16) }}
              >
                {lane.bars.map(({ run, left, width, row }) => {
                  const [tone, text] = runStateOf(run);
                  const runTime =
                    run.durationMs ?? Date.parse(run.endedAt ?? run.startedAt) - Date.parse(run.startedAt);
                  // Only a run with a REPORT line has its billed time and its memory, so only it has a cost.
                  const price = runPrice(run);
                  const timing =
                    run.outcome === 'running'
                      ? 'running'
                      : price === undefined
                        ? duration(runTime)
                        : `${duration(runTime)}, ${money(price.cost)} = ${price.formula}`;
                  return (
                    <button
                      key={run.runID}
                      type="button"
                      aria-label={`${stageLabels[run.stage]} run at ${clock(run.startedAt)}, ${text}`}
                      title={`${clock(run.startedAt)} · ${timing} · ${text}`}
                      onClick={() => onPick(run)}
                      className={cn(
                        'absolute cursor-pointer rounded-full transition-[filter] outline-none hover:brightness-125 focus-visible:ring-2 focus-visible:ring-ring',
                        toneFill[tone],
                        run.outcome === 'running' && 'animate-pulse motion-reduce:animate-none',
                        focused === run.runID && 'ring-2 ring-foreground/70 ring-offset-1 ring-offset-background'
                      )}
                      style={{
                        left: `min(${percent(left)}, calc(100% - 4px))`,
                        width: `max(${percent(width)}, 4px)`,
                        top: rowGap + row * (height + rowGap),
                        height,
                      }}
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
        <span />
        <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
          <span title={receivedAt === undefined ? 'The first run' : 'The email came in'}>
            {clock(new Date(timeline.start).toISOString())}
            {receivedAt !== undefined && ' · email in'}
          </span>
          <span>{offset(length)}</span>
        </div>
      </div>
    </figure>
  );
}

const emptyText: Record<StageName, string> = {
  inbox: 'No inbox run names this request. A standalone source has none.',
  leadSources: 'No source run names this request. An email without attachments has none.',
  leads: 'No lead run names this request. A source without valid leads has none.',
};

function StageSection({
  stage,
  section,
  place,
  requestID,
  receivedAt,
  openLogs,
  focused,
  onLogs,
}: {
  readonly stage: StageName;
  readonly section: Section<StageRuns>;
  readonly place: RequestRuns;
  readonly requestID: string;
  readonly receivedAt: string | undefined;
  readonly openLogs: ReadonlySet<string>;
  readonly focused: string | undefined;
  readonly onLogs: (runID: string, open: boolean) => void;
}) {
  const runs = section.ok ? section.value.runs : [];
  const tally = tallyOf(runs);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-extrabold tracking-tight">{stageLabels[stage]}</h3>
        {section.ok && runs.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {plural(tally.runs, 'run')} · {duration(tally.computeMs)} · {money(tally.lambda.cost)}
          </p>
        )}
        {section.ok && runs.length > 0 && <Formula className="basis-full">= {tally.lambda.formula}</Formula>}
        {section.ok && section.value.more && (
          <p className="text-xs text-warn">The logs have more. Only the first {fmt(runs.length)} runs are read.</p>
        )}
      </div>
      {!section.ok ? (
        <SectionError error={section.error} />
      ) : runs.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">{emptyText[stage]}</p>
      ) : (
        runs.map((run) => (
          <RunBox
            key={run.runID}
            run={run}
            requestID={requestID}
            receivedAt={receivedAt}
            logsUrl={runLogsUrl(place, section.value.logGroup, run.logStream, run.runID)}
            logsOpen={openLogs.has(run.runID)}
            focused={focused === run.runID}
            onLogs={(open) => onLogs(run.runID, open)}
          />
        ))
      )}
    </section>
  );
}

function Stat({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{label}</dt>
      <dd className="font-semibold">{children}</dd>
      {hint !== undefined && <dd className="text-xs text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** What a run cost, with its formula, and the part of it that the init time of a cold start took. */
function RunCost({ price, init }: { readonly price: Priced; readonly init: Priced | undefined }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/40 px-3 py-2 text-xs">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Cost</span>
        <span className="font-semibold">{money(price.cost)}</span>
        <Formula className="inline">= {price.formula}</Formula>
      </p>
      {init !== undefined && (
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-muted-foreground">of it, the init time</span>
          <span className="font-semibold">{money(init.cost)}</span>
          <Formula className="inline">= {init.formula}</Formula>
        </p>
      )}
    </div>
  );
}

/** The used share of the memory. A run near its limit is a warning, because the next can run out. */
function Memory({ used, size }: { readonly used: number; readonly size: number }) {
  const share = Math.min(1, used / size);
  const tone = share >= 0.9 ? 'critical' : share >= 0.7 ? 'warning' : 'ok';
  return (
    <span className="flex flex-col gap-1">
      <span className={cn(tone !== 'ok' && toneText[tone])}>
        {fmt(used)} / {fmt(size)} MB
      </span>
      <span className="flex h-1 w-full max-w-28 overflow-hidden rounded-full bg-muted">
        <span className={toneFill[tone]} style={{ width: `${share * 100}%` }} />
      </span>
    </span>
  );
}

const StepChip = ({ step, faded = false }: { readonly step: Step; readonly faded?: boolean }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 rounded-md border bg-card px-2 py-0.5 font-sans text-xs whitespace-nowrap',
      faded && 'opacity-60'
    )}
  >
    <i className={cn('size-1.5 flex-none rounded-full', toneFill[step.tone])} />
    {step.text}
  </span>
);

export function RunBox({
  run,
  requestID,
  receivedAt,
  logsUrl,
  logsOpen,
  focused,
  onLogs,
}: {
  readonly run: HandlerRun;
  readonly requestID: string;
  readonly receivedAt: string | undefined;
  readonly logsUrl: string | undefined;
  readonly logsOpen: boolean;
  readonly focused: boolean;
  readonly onLogs: (open: boolean) => void;
}) {
  const [tone, text] = runStateOf(run);
  const steps = runStepsOf(run, requestID);
  const afterEmail = receivedAt === undefined ? undefined : Date.parse(run.startedAt) - Date.parse(receivedAt);
  const price = runPrice(run);
  const init = run.initMs === undefined || run.memoryMb === undefined ? undefined : timePrice(run.initMs, run.memoryMb);
  return (
    <article
      id={`run-${run.runID}`}
      className={cn(
        'scroll-mt-2 overflow-hidden rounded-xl border bg-card transition-shadow',
        focused && 'ring-2 ring-ring/60'
      )}
    >
      <div className="flex flex-col gap-3.5 p-4">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Tag tone={tone}>{text}</Tag>
          <code className="font-mono text-xs text-muted-foreground" title="The ID that Lambda gives the run">
            {run.runID}
          </code>
          {run.initMs !== undefined && (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-live-soft px-2 py-0.5 text-xs font-semibold text-live"
              title="Lambda started a new execution environment for this run"
            >
              <Snowflake className="size-3" />
              cold start
            </span>
          )}
          {run.otherRequests > 0 && (
            <span className="text-xs text-muted-foreground" title="The run also worked on other requests">
              shared with {plural(run.otherRequests, 'other request')}
            </span>
          )}
          {logsUrl !== undefined && (
            <a
              href={logsUrl}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
            >
              CloudWatch <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stat label="Started" hint={afterEmail === undefined ? undefined : `${offset(afterEmail)} after the email`}>
            <span className="font-mono text-[13px]">{clock(run.startedAt)}</span>
          </Stat>
          <Stat label="Duration" hint={run.billedMs === undefined ? undefined : `billed ${duration(run.billedMs)}`}>
            {run.durationMs !== undefined ? (
              duration(run.durationMs)
            ) : (
              <span className="text-muted-foreground">{run.outcome === 'running' ? 'running' : '–'}</span>
            )}
          </Stat>
          <Stat label="Init" hint={run.initMs === undefined ? 'warm start' : 'cold start'}>
            {run.initMs === undefined ? <span className="text-muted-foreground">–</span> : duration(run.initMs)}
          </Stat>
          <Stat label="Memory">
            {run.maxMemoryMb !== undefined && run.memoryMb !== undefined ? (
              <Memory used={run.maxMemoryMb} size={run.memoryMb} />
            ) : (
              <span className="text-muted-foreground">–</span>
            )}
          </Stat>
        </dl>
        {price !== undefined && <RunCost price={price} init={init} />}
        {steps.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="What the run did for the request">
            {steps.map((step, index) => (
              <li key={index}>
                <StepChip step={step} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <Collapsible open={logsOpen} onOpenChange={onLogs}>
        <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 border-t bg-muted/40 px-4 py-2.5 text-left text-xs font-semibold outline-none hover:bg-muted focus-visible:bg-muted">
          <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          Logs
          <span className="font-normal text-muted-foreground">{plural(run.lines.length, 'line')}</span>
          {run.errors > 0 && <span className="text-crit">{plural(run.errors, 'error')}</span>}
          {run.warnings > 0 && <span className="text-warn">{plural(run.warnings, 'warning')}</span>}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <LogConsole run={run} requestID={requestID} />
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

type LineFilter = 'all' | 'code' | 'problems';

const lineFilters: readonly {
  readonly name: LineFilter;
  readonly label: string;
  readonly title: string;
  readonly keep: (line: RunLine) => boolean;
}[] = [
  { name: 'all', label: 'All', title: 'Show all lines', keep: () => true },
  {
    name: 'code',
    label: 'Handler',
    title: 'Show only the lines of the handler',
    keep: (line) => line.level !== 'platform',
  },
  {
    name: 'problems',
    label: 'Problems',
    title: 'Show only the errors and the warnings',
    keep: (line) => line.level === 'error' || line.level === 'warn',
  },
];

/**
 * The lines of one run, as a rail of events in time. Each line shows its time after the start of the run, and a dot in
 * the color of its level. A progress write shows as the steps that it records, not as its raw JSON.
 */
function LogConsole({ run, requestID }: { readonly run: HandlerRun; readonly requestID: string }) {
  const [filter, setFilter] = useState<LineFilter>('all');
  const start = Date.parse(run.startedAt);
  const shown = run.lines.filter(lineFilters.find(({ name }) => name === filter)!.keep);
  const raw = run.lines.map((line) => `${line.time}\t${line.level.toUpperCase()}\t${line.message}`).join('\n');
  return (
    <div className="border-t bg-background">
      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
        <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
          {lineFilters.map(({ name, label, title, keep }) => (
            <button
              key={name}
              type="button"
              aria-pressed={filter === name}
              title={title}
              onClick={() => setFilter(name)}
              className={cn(
                'cursor-pointer rounded-[5px] px-2 py-0.5 text-xs font-semibold text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring',
                filter === name && 'bg-card text-foreground shadow-sm'
              )}
            >
              {label} <span className="font-normal opacity-70">{fmt(run.lines.filter(keep).length)}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto" />
        <CopyButton text={raw} label="Copy the lines of the run" withText />
      </div>
      {shown.length === 0 ? (
        <p className="px-4 py-4 text-xs text-muted-foreground">No lines.</p>
      ) : (
        <ol className="max-h-[440px] overflow-y-auto py-2 font-mono text-xs leading-relaxed">
          {shown.map((line, index) => (
            <LogLine key={index} line={line} start={start} requestID={requestID} />
          ))}
        </ol>
      )}
      {run.truncated && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Only the first {fmt(runLineLimit)} lines are shown. The CloudWatch console has all of them.
        </p>
      )}
    </div>
  );
}

const dotClass: Record<RunLine['level'], string> = {
  error: 'bg-crit',
  warn: 'bg-warn',
  info: 'bg-muted-foreground/70',
  debug: 'bg-muted-foreground/40',
  platform: 'border border-muted-foreground/60 bg-background',
};

const rowClass: Partial<Record<RunLine['level'], string>> = {
  error: 'bg-crit-soft/60',
  warn: 'bg-warn-soft/50',
};

/** A message longer than this many lines or characters is cut until the person opens it. */
const foldLines = 6;
const foldCharacters = 600;

function LogLine({
  line,
  start,
  requestID,
}: {
  readonly line: RunLine;
  readonly start: number;
  readonly requestID: string;
}) {
  const [open, setOpen] = useState(false);
  const steps = line.progress === undefined ? [] : stepsOf(line.progress.change);
  const other = line.progress !== undefined && line.progress.requestID !== requestID;
  const long = line.message.split('\n').length > foldLines || line.message.length > foldCharacters;
  const keyword = line.level === 'platform' ? /^(START|END|REPORT)\b\s*/.exec(line.message) : null;

  let body: ReactNode;
  if (line.progress !== undefined && steps.length > 0) {
    body = (
      <span className="flex flex-wrap items-center gap-1.5" title={line.message}>
        {steps.map((step, index) => (
          <StepChip key={index} step={step} faded={other} />
        ))}
        {other && (
          <span className="text-muted-foreground">
            of request{' '}
            <span className="inline-block max-w-[14ch] truncate align-bottom">{line.progress.requestID}</span>
          </span>
        )}
      </span>
    );
  } else if (keyword !== null) {
    body = (
      <span className="text-muted-foreground">
        <span className="mr-2 text-[10px] font-semibold tracking-wider">{keyword[1]}</span>
        {line.message.slice(keyword[0].length).replace(/^RequestId: \S+\s*/, '')}
      </span>
    );
  } else {
    body = (
      <>
        <span
          className={cn(
            'block break-words whitespace-pre-wrap',
            line.level === 'error' && 'text-crit',
            long && !open && 'line-clamp-6'
          )}
        >
          {line.message}
        </span>
        {long && (
          <button
            type="button"
            className="mt-0.5 cursor-pointer font-sans text-[11px] font-semibold text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
          >
            {open ? 'Show less' : 'Show all'}
          </button>
        )}
      </>
    );
  }

  return (
    <li className={cn('grid grid-cols-[76px_18px_1fr] pr-4', rowClass[line.level])}>
      <span className="py-1 pr-2 text-right text-muted-foreground tabular-nums" title={clock(line.time)}>
        +{((Date.parse(line.time) - start) / 1000).toFixed(3)}
      </span>
      <span className="relative flex justify-center">
        <span className="absolute inset-y-0 w-px bg-border" />
        <span className={cn('relative mt-[9px] size-[7px] rounded-full', dotClass[line.level])} />
      </span>
      <span className="min-w-0 py-1 pl-1">{body}</span>
    </li>
  );
}

export function CopyButton({
  text,
  label,
  withText = false,
}: {
  readonly text: string;
  readonly label: string;
  readonly withText?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The button can sit in a row that opens on a click.
        event.stopPropagation();
        void copy();
      }}
      className="inline-flex flex-none cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 font-sans text-xs font-semibold text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className={cn('size-3.5', copied && 'text-ok')} />
      {withText && (copied ? 'Copied' : 'Copy')}
    </button>
  );
}

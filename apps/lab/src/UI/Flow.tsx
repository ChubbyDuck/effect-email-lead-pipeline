import { stageLabels, stageNames, type StageName, stageSlugs } from '@leads/shared/domain/stages';
import { Skeleton } from '@leads/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@leads/ui/components/tooltip';
import { cn } from '@leads/ui/lib/utils';
import { CircleAlert, Info, type LucideIcon, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { lambdaPrice } from '#Core/Observation/Domain/costs';
import type { CauseInput, DlqCauseResult, DlqResult, RedriveResult } from '#Core/Observation/Domain/dlq';
import { type Finding, type Level, overall, type Place } from '#Core/Observation/Domain/health';
import {
  type BucketStatus,
  type HandlerStatus,
  peak,
  type QueueStatus,
  type Series,
  type Snapshot,
  total,
} from '#Core/Observation/Domain/snapshot';
import { span } from '#Core/Observation/Domain/time';

import { type DlqRead, DlqSheet } from './DlqSheet';
import { breakdown, FindingList } from './Findings';
import { bytes, fmt, money } from './format';
import { Formula } from './Formula';
import { Panel } from './Panel';
import { Spark } from './Spark';
import { type Tone, toneText } from './Tag';

/** The failed runs and the longest run of a handler, with what the longest run cost. */
function LongestRun({ handler }: { readonly handler: HandlerStatus }) {
  const longest = peak(handler.durationMax);
  const price = lambdaPrice(longest, handler.memoryMb);
  return (
    <>
      <span className="block truncate">
        {fmt(total(handler.errors))} failed · longest {(longest / 1000).toFixed(1)} of {handler.timeoutSeconds} s
      </span>
      <Formula className="mt-0.5 text-[10px]">
        <span className="font-semibold text-foreground">{money(price.cost)}</span> = {price.formula}
      </Formula>
    </>
  );
}

/** The resources of one stage that the snapshot could read. */
export interface StageParts {
  readonly handler?: HandlerStatus;
  readonly main?: QueueStatus;
  readonly dlq?: QueueStatus;
  readonly bucket?: BucketStatus;
}

export interface Health {
  readonly tone: Tone;
  readonly text: string;
}

export function partsOf(snapshot: Snapshot, stage: StageName): StageParts {
  const queues = snapshot.queues.ok ? snapshot.queues.value : [];
  const handler = snapshot.handlers.ok ? snapshot.handlers.value.find((item) => item.stage === stage) : undefined;
  const main = queues.find((queue) => queue.stage === stage && queue.role === 'main');
  const dlq = queues.find((queue) => queue.stage === stage && queue.role === 'dlq');
  const bucket = snapshot.buckets.ok ? snapshot.buckets.value.find((item) => item.stage === stage) : undefined;
  return {
    ...(handler !== undefined && { handler }),
    ...(main !== undefined && { main }),
    ...(dlq !== undefined && { dlq }),
    ...(bucket !== undefined && { bucket }),
  };
}

/** The counts of the findings of a column, in the color of the worst. A column without findings has none. */
function findingHealth(findings: readonly Finding[]): Health | undefined {
  const worst = overall(findings);
  return worst === 'ok' ? undefined : { tone: worst, text: breakdown(findings) };
}

/**
 * The head of the column of one stage. The findings of its boxes give its color. A stage without findings shows the
 * work that it has now, which is not a problem.
 */
export function stageHealth({ handler, main, bucket }: StageParts, findings: readonly Finding[]): Health {
  const found = findingHealth(findings);
  if (found !== undefined) return found;
  const waiting = bucket?.objects.length ?? 0;
  if (waiting > 0) return { tone: 'info', text: `${fmt(waiting)}${bucket?.truncated ? '+' : ''} in the bucket` };
  const queued = main === undefined ? 0 : main.visible + main.inFlight;
  if (queued > 0) return { tone: 'info', text: `${fmt(queued)} in the queue` };
  if (handler === undefined || total(handler.invocations) === 0) return { tone: 'neutral', text: 'idle' };
  return { tone: 'ok', text: 'clear' };
}

/** The head of the column of the orders table. The findings of the table give its color. */
export const tableHealth = (findings: readonly Finding[]): Health =>
  findingHealth(findings) ?? { tone: 'ok', text: 'accepts writes' };

const placeKey = (place: Place) => `${place.stage}/${place.part}`;

/** The findings of each box on the map, in the order of the list. A finding without a place is on no box. */
export function findingsByPlace(findings: readonly Finding[]): ReadonlyMap<string, readonly Finding[]> {
  const byPlace = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.place === undefined) continue;
    const key = placeKey(finding.place);
    byPlace.set(key, [...(byPlace.get(key) ?? []), finding]);
  }
  return byPlace;
}

const plural = (count: number, noun: string) => `${noun}${count === 1 ? '' : 's'}`;

/**
 * The fixed sizes of the map, in px. Every box of a row has one height, so the rows of the four columns align, and the
 * arrow to the next column can sit at the middle of the handler row. The handler row is taller, because its boxes show
 * how the cost of the longest run was calculated.
 */
const columnPadding = 14;
const headHeight = 56 + 12;
const boxHeight = 116;
const handlerBoxHeight = 164;
const linkHeight = 22;
const handlerMiddle = columnPadding + headHeight + 2 * (boxHeight + linkHeight) + handlerBoxHeight / 2;
/** The rows of a column: the bucket, the queue, the handler, and the DLQ. */
const rowHeights = [boxHeight, boxHeight, handlerBoxHeight, boxHeight];

const boxRing: Record<Level, string> = {
  critical: 'border-crit ring-4 ring-crit/15',
  warning: 'border-warn ring-4 ring-warn/15',
  info: 'border-live ring-4 ring-live/10',
};

const valueText: Record<Level, string> = { critical: 'text-crit', warning: 'text-warn', info: 'text-live' };

const columnSurface: Record<Tone, string> = {
  critical: 'border-crit/25 bg-crit-soft/60',
  warning: 'border-warn/25 bg-warn-soft/60',
  info: 'border-live/25 bg-live-soft/60',
  ok: 'border-ok/25 bg-ok-soft/60',
  neutral: 'border-border bg-muted/50',
};

function Kind({ children }: { readonly children: ReactNode }) {
  return (
    <span className="flex-none rounded bg-muted px-1.5 font-mono text-[10px] font-semibold tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/** The findings of one box, which show when the pointer is on the box. */
const levelIcon: Record<Level, LucideIcon> = { critical: CircleAlert, warning: TriangleAlert, info: Info };

/**
 * The icon of the worst finding of a box, at its upper right corner. The findings of the box show when the pointer is
 * on the icon. The empty `title` keeps the title of the box away from the icon.
 */
function FindingIcon({ findings, worst }: { readonly findings: readonly Finding[]; readonly worst: Level }) {
  const Icon = levelIcon[worst];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span title="" className={cn('ml-auto flex-none cursor-help', valueText[worst])}>
          <Icon aria-hidden className="size-4" />
          <span className="sr-only">{findings.map((finding) => `${finding.level}: ${finding.message}`).join(' ')}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className="max-w-xs bg-popover px-3 py-2.5 text-popover-foreground shadow-md"
      >
        <ul className="flex flex-col gap-1.5">
          {findings.map((finding, index) => (
            <li key={index} className="text-balance">
              <span
                className={cn('mr-1.5 text-[10px] font-extrabold tracking-wider uppercase', valueText[finding.level])}
              >
                {finding.level}
              </span>
              {finding.message}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** One resource on the map. The worst of its findings colors the box and gives the icon of its findings. */
function Box({
  kind,
  name,
  title,
  value,
  unit,
  detail,
  findings = [],
  series,
  errors,
  height = boxHeight,
  onOpen,
}: {
  readonly kind: string;
  readonly name: string;
  /** The full name of the resource, when the box shows a short one. */
  readonly title?: string;
  readonly value: ReactNode;
  readonly unit: ReactNode;
  readonly detail: ReactNode;
  readonly findings?: readonly Finding[] | undefined;
  readonly series?: Series;
  readonly errors?: Series;
  readonly height?: number;
  /** Opens the details of the resource. A box without it is not a button. */
  readonly onOpen?: () => void;
}) {
  const worst = overall(findings);
  const Element = onOpen === undefined ? 'div' : 'button';
  return (
    <Element
      {...(onOpen !== undefined && { type: 'button', onClick: onOpen, title: `Show the messages of ${title ?? name}` })}
      className={cn(
        'flex flex-col rounded-[10px] border-[1.5px] bg-card px-3 py-2.5',
        worst === 'ok' ? 'border-border' : boxRing[worst],
        onOpen !== undefined &&
          'w-full cursor-pointer text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring'
      )}
      style={{ height }}
    >
      <div className="flex h-[22px] items-center gap-2">
        <Kind>{kind}</Kind>
        <span className="truncate font-mono text-xs text-muted-foreground" title={title ?? name}>
          {name}
        </span>
        {worst !== 'ok' && <FindingIcon findings={findings} worst={worst} />}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span
          className={cn(
            'text-2xl leading-tight font-extrabold tracking-tight',
            worst === 'ok' ? undefined : valueText[worst]
          )}
        >
          {value}
        </span>
        <span className="truncate text-xs text-muted-foreground">{unit}</span>
      </div>
      <div className="truncate text-xs text-muted-foreground">{detail}</div>
      {series !== undefined && (
        <Spark series={series} {...(errors !== undefined && { errors })} className="mt-auto h-3.5" />
      )}
    </Element>
  );
}

/** A place in a column where the stage has no resource. It keeps the rows of the map aligned. */
function Gap({
  kind,
  children,
  height = boxHeight,
}: {
  readonly kind: string;
  readonly children: ReactNode;
  readonly height?: number;
}) {
  return (
    <div
      className="flex flex-col justify-center gap-1 rounded-[10px] border-[1.5px] border-dashed border-input p-3 text-muted-foreground"
      style={{ height }}
    >
      <span className="font-mono text-[10px] font-semibold tracking-wide">{kind}</span>
      <span className="text-xs leading-snug">{children}</span>
    </div>
  );
}

/** A resource that the snapshot could not read. */
function Unread({ kind, error, height }: { readonly kind: string; readonly error: string; readonly height?: number }) {
  return (
    <Gap kind={kind} {...(height !== undefined && { height })}>
      <span className="line-clamp-3 text-crit" title={error}>
        Cannot read: {error}
      </span>
    </Gap>
  );
}

/** The arrow from one box down to the next box of its column. */
function Link({ label, dashed = false }: { readonly label?: string; readonly dashed?: boolean }) {
  return (
    <div aria-hidden className="flex items-center gap-2 pl-[18px]" style={{ height: linkHeight }}>
      <span className={cn('h-full border-l-2 border-input', dashed && 'border-dashed')} />
      {label !== undefined && <span className="text-[11px] text-muted-foreground">{label}</span>}
    </div>
  );
}

/** One column of the map. The arrow to the next column starts at the middle of the handler row. */
function Column({
  name,
  health,
  source,
  out,
  children,
}: {
  readonly name: string;
  readonly health: Health;
  readonly source: string;
  /** What the stage gives to the next stage. The last stage gives nothing. */
  readonly out?: string;
  readonly children: ReactNode;
}) {
  return (
    <li className="relative min-w-0">
      <div className={cn('rounded-[14px] border', columnSurface[health.tone])} style={{ padding: columnPadding }}>
        <div style={{ height: headHeight - 12, marginBottom: 12 }}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-base font-extrabold">{name}</h3>
            <span className={cn('text-xs font-bold whitespace-nowrap', toneText[health.tone])}>{health.text}</span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={source}>
            {source}
          </p>
        </div>
        {children}
      </div>
      {out !== undefined && (
        <div aria-hidden className="absolute left-full h-[30px] w-16" style={{ top: handlerMiddle - 15 }}>
          <span className="absolute inset-x-0 -top-0.5 text-center text-[11px] text-muted-foreground">{out}</span>
          <span className="absolute top-[21px] right-[9px] left-1 h-0.5 bg-input" />
          <span className="absolute top-4 right-[3px] size-0 border-y-[6px] border-l-8 border-y-transparent border-l-input" />
        </div>
      )}
    </li>
  );
}

const stageSources: Record<Exclude<StageName, 'inbox'>, string> = {
  leadSources: 'one message for each attachment',
  leads: 'the leads that the sources found',
};

const stageOut: Record<StageName, string> = { inbox: 'attachments', leadSources: 'leads', leads: 'orders' };

/** The short name of a handler, such as `InboxHandler`. The stack adds a prefix and a hash to it. */
const handlerName = (handler: HandlerStatus) =>
  /([A-Za-z]+Handler)/.exec(handler.functionName)?.[1] ?? `${stageLabels[handler.stage]} handler`;

function StageColumn({
  snapshot,
  stage,
  findings,
  onOpenDlq,
}: {
  readonly snapshot: Snapshot;
  readonly stage: StageName;
  readonly findings: ReadonlyMap<string, readonly Finding[]>;
  readonly onOpenDlq: (stage: StageName) => void;
}) {
  const now = Date.parse(snapshot.collectedAt);
  const parts = partsOf(snapshot, stage);
  const { handler, main, dlq, bucket } = parts;
  const slug = stageSlugs[stage];
  const at = (part: Place['part']) => findings.get(`${stage}/${part}`);
  const missing = (error: string | undefined) => error ?? 'the snapshot has no such resource';
  const queuesError = snapshot.queues.ok ? undefined : snapshot.queues.error;
  const window = `in ${snapshot.windowHours} h`;

  const bucketBox =
    stage === 'leads' ? (
      <Gap kind="NO BUCKET">The lead-sources handler sends each lead straight to the queue.</Gap>
    ) : bucket === undefined ? (
      <Unread kind="S3" error={missing(snapshot.buckets.ok ? undefined : snapshot.buckets.error)} />
    ) : (
      <Box
        kind="S3"
        name={slug}
        title={bucket.name}
        value={`${fmt(bucket.objects.length)}${bucket.truncated ? '+' : ''}`}
        unit={plural(bucket.objects.length, 'object')}
        detail={
          bucket.objects.length === 0
            ? 'empty'
            : `oldest ${span((now - Date.parse(bucket.objects.at(-1)?.lastModified ?? '')) / 1000)}`
        }
        findings={at('bucket')}
      />
    );

  const queueBox =
    main === undefined ? (
      <Unread kind="SQS" error={missing(queuesError)} />
    ) : (
      <Box
        kind="SQS"
        name={slug}
        title={main.name}
        value={`${fmt(main.visible)} / ${fmt(main.inFlight)}`}
        unit="visible / in flight"
        detail={[
          `${fmt(total(main.sent))} sent ${window}`,
          ...(main.delayed > 0 ? [`${fmt(main.delayed)} delayed`] : []),
          ...(main.visible > 0 && main.oldestAgeSeconds !== undefined ? [`oldest ${span(main.oldestAgeSeconds)}`] : []),
        ].join(' · ')}
        findings={at('queue')}
        series={main.sent}
      />
    );

  const handlerBox =
    handler === undefined ? (
      <Unread
        kind="λ"
        error={missing(snapshot.handlers.ok ? undefined : snapshot.handlers.error)}
        height={handlerBoxHeight}
      />
    ) : (
      <Box
        kind="λ"
        name={handlerName(handler)}
        title={handler.functionName}
        value={fmt(total(handler.invocations))}
        unit={plural(total(handler.invocations), 'run')}
        detail={
          handler.state !== 'Active' ? (
            `function ${handler.state}`
          ) : handler.mapping.state !== 'Enabled' ? (
            `trigger ${handler.mapping.state}`
          ) : (
            <LongestRun handler={handler} />
          )
        }
        findings={at('handler')}
        series={handler.invocations}
        errors={handler.errors}
        height={handlerBoxHeight}
      />
    );

  const failed = dlq === undefined ? 0 : dlq.visible + dlq.inFlight + dlq.delayed;
  const dlqBox =
    dlq === undefined ? (
      <Unread kind="DLQ" error={missing(queuesError)} />
    ) : (
      <Box
        kind="DLQ"
        name={`${slug}-dlq`}
        title={dlq.name}
        value={fmt(failed)}
        unit={plural(failed, 'message')}
        detail={`kept ${span(dlq.retentionSeconds)}`}
        findings={at('dlq')}
        onOpen={() => onOpenDlq(stage)}
      />
    );

  const receives = main?.maxReceiveCount;
  return (
    <Column
      name={stageLabels[stage]}
      health={stageHealth(
        parts,
        (['bucket', 'queue', 'handler', 'dlq'] as const).flatMap((part) => at(part) ?? [])
      )}
      source={
        stage === 'inbox'
          ? snapshot.inboxAddress === undefined
            ? 'SES receives no email here'
            : `SES · ${snapshot.inboxAddress}`
          : stageSources[stage]
      }
      out={stageOut[stage]}
    >
      {bucketBox}
      {stage === 'leads' ? <Link dashed /> : <Link label="object created" />}
      {queueBox}
      <Link label={handler === undefined ? 'trigger' : `trigger · batch ${handler.mapping.batchSize}`} />
      {handlerBox}
      <Link
        label={
          receives === undefined
            ? 'failed messages'
            : `after ${receives} failed ${receives === 1 ? 'receive' : 'receives'}`
        }
      />
      {dlqBox}
    </Column>
  );
}

function OrdersColumn({
  snapshot,
  findings,
}: {
  readonly snapshot: Snapshot;
  readonly findings: ReadonlyMap<string, readonly Finding[]>;
}) {
  const source = 'written by the lead handler';
  const window = `in ${snapshot.windowHours} h`;
  if (!snapshot.orders.ok) {
    return (
      <Column name="Orders" health={{ tone: 'warning', text: 'cannot read' }} source={source}>
        <Unread kind="DDB" error={snapshot.orders.error} />
      </Column>
    );
  }
  const orders = snapshot.orders.value;
  const throttles = total(orders.throttles);
  return (
    <Column name="Orders" health={tableHealth(findings.get('orders/table') ?? [])} source={source}>
      <Box
        kind="DDB"
        name="orders"
        title={orders.name}
        value={fmt(orders.itemCount)}
        unit={<span title="DynamoDB updates this count about every 6 hours">items, approx.</span>}
        detail={`${bytes(orders.sizeBytes)} · ${orders.status}`}
        findings={findings.get('orders/table')}
      />
      <Link />
      <Box
        kind="WRITES"
        name="consumed capacity"
        value={fmt(total(orders.writes))}
        unit="write units"
        detail={window}
        series={orders.writes}
      />
      <Link />
      <Box
        kind="THROTTLES"
        name="write throttles"
        value={fmt(throttles)}
        unit={plural(throttles, 'throttled write')}
        detail={window}
        series={orders.throttles}
        height={handlerBoxHeight}
      />
      <Link dashed />
      <Gap kind="NO DLQ">The table has no dead-letter queue of its own.</Gap>
    </Column>
  );
}

function MapSkeleton() {
  return Array.from({ length: 4 }, (_, column) => (
    <li key={column} className="rounded-[14px] border bg-muted/50" style={{ padding: columnPadding }}>
      <Skeleton className="mb-3 h-[56px]" />
      <div className="flex flex-col" style={{ gap: linkHeight }}>
        {rowHeights.map((height, row) => (
          <Skeleton key={row} style={{ height }} />
        ))}
      </div>
    </li>
  ));
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-3.5 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-crit" />
        critical
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] bg-warn" />
        warning
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2.5 rounded-[3px] border-[1.5px] border-dashed border-input" />
        no resource
      </span>
    </div>
  );
}

/**
 * Reads the messages of the DLQ of a stage and the run that failed one of them, and sends a message back to its queue,
 * through the server.
 */
export interface DlqReader {
  readonly messages: (stage: StageName) => Promise<DlqResult>;
  readonly cause: (input: CauseInput) => Promise<DlqCauseResult>;
  readonly redrive: (stage: StageName, messageId: string) => Promise<RedriveResult>;
}

/**
 * The map of the pipeline: one equal column for each stage and one for the orders table, each resource in its own
 * box. The boxes of one kind share a row. A box with findings has an icon that shows them on hover. Below the map are
 * the counts of the findings and the findings that are on no box. A DLQ
 * box opens a sheet with the messages of the DLQ.
 */
export function Flow({
  snapshot,
  findings,
  overall,
  windowHours,
  readDlq,
}: {
  readonly snapshot: Snapshot | undefined;
  /** No findings while the first snapshot loads. */
  readonly findings: readonly Finding[] | undefined;
  readonly overall: Level | 'ok' | undefined;
  readonly windowHours: number;
  readonly readDlq: DlqReader;
}) {
  const byPlace = findingsByPlace(findings ?? []);
  const [dlqRead, setDlqRead] = useState<DlqRead>();
  const [dlqOpen, setDlqOpen] = useState(false);
  const openDlq = (stage: StageName) => {
    setDlqRead({ stage, result: readDlq.messages(stage) });
    setDlqOpen(true);
  };
  return (
    <Panel
      title="Pipeline"
      description="Email to orders. Each box is one AWS resource; hover the icon of a colored box to read its findings."
    >
      <Legend />
      <div className="-mx-1 mt-3 overflow-x-auto px-1 pt-1 pb-1">
        <ol className="grid min-w-[1080px] grid-cols-4 gap-x-16">
          {snapshot === undefined ? (
            <MapSkeleton />
          ) : (
            <>
              {stageNames.map((stage) => (
                <StageColumn key={stage} snapshot={snapshot} stage={stage} findings={byPlace} onOpenDlq={openDlq} />
              ))}
              <OrdersColumn snapshot={snapshot} findings={byPlace} />
            </>
          )}
        </ol>
      </div>
      <div className="mt-5 border-t pt-4">
        <FindingList findings={findings} overall={overall} windowHours={windowHours} />
      </div>
      <DlqSheet
        read={dlqRead}
        open={dlqOpen}
        onOpenChange={setDlqOpen}
        readCause={readDlq.cause}
        redrive={readDlq.redrive}
        onRefresh={() => {
          if (dlqRead !== undefined) setDlqRead({ stage: dlqRead.stage, result: readDlq.messages(dlqRead.stage) });
        }}
      />
    </Panel>
  );
}

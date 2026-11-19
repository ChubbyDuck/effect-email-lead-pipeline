import { Alert, AlertDescription } from '@leads/ui/components/alert';
import { Button } from '@leads/ui/components/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@leads/ui/components/table';
import { cn } from '@leads/ui/lib/utils';
import { CircleAlert, Pause, Play } from 'lucide-react';
import { useState } from 'react';

import type { DetailsResult } from '#Core/Observation/Domain/details';
import type { DeadLetterCounts, DeadLetters } from '#Core/Observation/Domain/dlq';
import { type RequestView, waitingOf } from '#Core/Observation/Domain/requests';

import { ago, fmt, time } from './format';
import { Loading, Panel } from './Panel';
import { PollMeter } from './PollMeter';
import { type FeedState, liveOf, requestsInWindow, type ShownState, shownStateOf, stateText } from './requestFeed';
import { CopyButton, RequestSheet, type RunsRead } from './RequestSheet';
import { Tag, type Tone, toneFill } from './Tag';
import { useNow } from './useRequestFeed';

/** Reads the details of a request through the server. The server picks the time in which to search its runs. */
export type RunsReader = (requestID: string) => Promise<DetailsResult>;

/** The most rows in the table. */
const requestLimit = 200;

const inboxTone = { pending: 'info', processed: 'ok', rejected: 'warning', failed: 'critical' } as const;

/** `queue` waits for a handler in the main queue. `dlq` waits for a redrive in the DLQ. */
type Part = 'processed' | 'pending' | 'queue' | 'dlq' | 'rejected' | 'failed';

const parts: readonly Part[] = ['processed', 'pending', 'queue', 'dlq', 'rejected', 'failed'];

const partText = (part: Part) => (part === 'queue' ? 'in queue' : part === 'dlq' ? 'in DLQ' : part);

const partFill: Record<Part, string> = {
  processed: 'bg-ok',
  pending: 'bg-live',
  queue: 'bg-live/35',
  dlq: 'bg-crit/40',
  rejected: 'bg-warn',
  failed: 'bg-crit',
};

/**
 * A stacked bar of one stage, the processed part of the total, and the other non-zero parts. Each part grows by its
 * share of the total, and the shares add to at most 1, so the rest of the bar stays empty.
 */
function Progress({ counts, total }: { readonly counts: Record<Part, number>; readonly total: number | undefined }) {
  const shown = parts.filter((part) => counts[part] > 0);
  const others = shown.filter((part) => part !== 'processed');
  const whole = Math.max(
    total ?? 0,
    shown.reduce((sum, part) => sum + counts[part], 0),
    1
  );
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-1.5 w-24 flex-none overflow-hidden rounded-full bg-muted">
        {shown.map((part) => (
          <span
            key={part}
            className={cn('transition-[flex-grow] duration-500 motion-reduce:transition-none', partFill[part])}
            style={{ flexGrow: counts[part] / whole }}
          />
        ))}
      </div>
      <span>
        {fmt(counts.processed)} / {total === undefined ? '?' : fmt(total)}
      </span>
      {others.length > 0 && (
        <span className="text-xs text-muted-foreground">
          {others.map((part, index) => (
            <span key={part} className={cn(part === 'dlq' && 'font-semibold text-crit')}>
              {index > 0 && ', '}
              {fmt(counts[part])} {partText(part)}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function RequestRow({
  request,
  deadLetters,
  changes,
  now,
  selected,
  onSelect,
}: {
  readonly request: RequestView;
  readonly deadLetters: DeadLetterCounts | undefined;
  readonly changes: number;
  readonly now: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const [tone, text] = stateText[shownStateOf(request, now, deadLetters)];
  const waiting = waitingOf(request, deadLetters);
  return (
    <TableRow
      className={cn('cursor-pointer', changes > 0 && `flash-${changes % 2}`)}
      data-state={selected ? 'selected' : undefined}
      tabIndex={0}
      aria-label={`Show the details of request ${request.requestID}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        // A key on the copy button of the row belongs to the button.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onSelect();
      }}
    >
      <TableCell className="align-top">
        <div className="-my-px flex items-center gap-1">
          <code className="inline-block max-w-[18ch] truncate align-bottom font-mono text-xs" title={request.requestID}>
            {request.requestID}
          </code>
          <CopyButton text={request.requestID} label="Copy the request ID" />
        </div>
      </TableCell>
      <TableCell className="align-top">
        <Tag tone={tone}>{text}</Tag>
      </TableCell>
      <TableCell className="align-top" title={request.receivedAt}>
        {request.receivedAt === undefined ? <span className="text-muted-foreground">–</span> : time(request.receivedAt)}
      </TableCell>
      <TableCell className="align-top">
        {request.inboxStatus === undefined ? (
          <span
            className="text-muted-foreground"
            title="No inbox entry: a standalone source, or progress before the acknowledgement"
          >
            –
          </span>
        ) : waiting.inboxInDlq ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-crit">
            <span className={cn('size-[7px] rounded-full', toneFill.critical)} />
            in DLQ
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs">
            <span className={cn('size-[7px] rounded-full', toneFill[inboxTone[request.inboxStatus]])} />
            {request.inboxStatus}
          </span>
        )}
      </TableCell>
      <TableCell className="align-top">
        <Progress
          counts={{
            processed: request.sourcesProcessed,
            pending: request.sourcesPending,
            queue: waiting.sourcesInQueue ?? 0,
            dlq: waiting.sourcesInDlq,
            rejected: request.sourcesRejected,
            failed: request.sourcesFailed,
          }}
          total={request.attachments}
        />
      </TableCell>
      <TableCell className="align-top">
        <Progress
          counts={{
            processed: request.leadsProcessed,
            pending: request.leadsPending,
            queue: waiting.leadsInQueue,
            dlq: waiting.leadsInDlq,
            rejected: request.leadsRejected,
            failed: request.leadsFailed,
          }}
          total={request.sourcesLeads}
        />
      </TableCell>
      <TableCell className="align-top text-muted-foreground" title={request.updatedAt}>
        {ago(request.updatedAt, now)}
      </TableCell>
    </TableRow>
  );
}

const liveTone: Record<string, Tone> = { ok: 'ok', warning: 'warning', critical: 'critical' };

/** The state of the stream of the request ledger. The dot pulses while the stream is live. */
function Live({ feed }: { readonly feed: FeedState }) {
  const live = liveOf(feed);
  const tone = live.level === undefined ? 'neutral' : (liveTone[live.level] ?? 'neutral');
  return (
    <Tag
      tone={tone}
      className="gap-1.5"
      title={
        feed.status?.readAt === undefined ? 'Connection to the request ledger' : `Last read ${time(feed.status.readAt)}`
      }
    >
      <span className="relative flex size-1.5">
        {tone === 'ok' && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:hidden" />
        )}
        <span className={cn('relative inline-flex size-1.5 rounded-full', toneFill[tone])} />
      </span>
      {live.text}
    </Tag>
  );
}

/**
 * The live table of the requests in the window. It updates the ages and the stalled requests each second. A row opens
 * the details of its request in a sheet.
 */
export function Requests({
  feed,
  deadLetters = {},
  windowHours,
  readRuns,
  onPause,
}: {
  readonly feed: FeedState;
  /** The DLQ messages of each request, from the last snapshot. Without them, every waiting message shows in queue. */
  readonly deadLetters?: DeadLetters;
  readonly windowHours: number;
  readonly readRuns: RunsReader;
  /** Stops or starts the polls of the ledger for this page. */
  readonly onPause: (paused: boolean) => void;
}) {
  const paused = feed.connection === 'paused';
  const now = useNow(1000);
  // The sheet keeps the last read while it closes, so that its content does not go away during the animation.
  const [read, setRead] = useState<RunsRead>();
  const [open, setOpen] = useState(false);
  const selected = read === undefined ? undefined : feed.requests.get(read.requestID);

  const readOf = (request: RequestView): RunsRead => ({
    requestID: request.requestID,
    result: readRuns(request.requestID),
  });

  const rows = requestsInWindow(feed, windowHours, now);
  const counts = new Map<ShownState, number>();
  for (const row of rows) {
    const state = shownStateOf(row, now, deadLetters[row.requestID]);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const summary = [
    `${fmt(rows.length)} in the last ${windowHours} h`,
    ...(['active', 'stalled', 'failed', 'rejected', 'done'] as const).flatMap((state) => {
      const count = counts.get(state) ?? 0;
      return count > 0 ? [`${fmt(count)} ${stateText[state][1]}`] : [];
    }),
  ];
  const error =
    feed.status?.ok === false ? (
      <Alert variant="destructive" className="mb-3 border-crit/30 bg-crit-soft">
        <CircleAlert />
        <AlertDescription className="text-crit">Cannot read the request ledger: {feed.status.error}</AlertDescription>
      </Alert>
    ) : null;

  return (
    <Panel
      title={
        <>
          Requests <Live feed={feed} />
          <Button
            variant="ghost"
            size="sm"
            className="h-7 rounded-full px-2.5 text-xs font-semibold text-muted-foreground"
            onClick={() => onPause(!paused)}
            title={
              paused
                ? 'Read the ledger again every 2 s'
                : 'Stop the polls of the ledger for this page. The server stops when no page listens.'
            }
          >
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </>
      }
      description={feed.loaded ? summary.join(', ') : undefined}
      action={
        feed.loaded && rows.length > 0 ? (
          <ul className="hidden flex-wrap justify-end gap-x-3 gap-y-1 text-xs text-muted-foreground lg:flex">
            {parts.map((part) => (
              <li key={part} className="flex items-center gap-1.5">
                <i className={cn('inline-block h-1.5 w-2.5 rounded-full', partFill[part])} />
                {partText(part)}
              </li>
            ))}
          </ul>
        ) : undefined
      }
    >
      <PollMeter feed={feed} />
      {error}
      {!feed.loaded ? (
        paused ? (
          <p className="py-6 text-center text-muted-foreground">The requests are paused. Resume to read the ledger.</p>
        ) : (
          error === null && <Loading />
        )
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-muted-foreground">
          No requests in the last {windowHours} h. Send an email to the inbox, and it shows here at once.
        </p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="text-muted-foreground">Request</TableHead>
                <TableHead className="text-muted-foreground">State</TableHead>
                <TableHead className="text-muted-foreground">Received</TableHead>
                <TableHead className="text-muted-foreground">Inbox</TableHead>
                <TableHead className="text-muted-foreground">Sources</TableHead>
                <TableHead className="text-muted-foreground">Leads</TableHead>
                <TableHead className="text-muted-foreground">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, requestLimit).map((request) => (
                <RequestRow
                  key={request.requestID}
                  request={request}
                  deadLetters={deadLetters[request.requestID]}
                  changes={feed.changes.get(request.requestID) ?? 0}
                  now={now}
                  selected={open && read?.requestID === request.requestID}
                  onSelect={() => {
                    setRead(readOf(request));
                    setOpen(true);
                  }}
                />
              ))}
            </TableBody>
          </Table>
          {rows.length > requestLimit && (
            <p className="mt-2 text-xs text-muted-foreground">Only the newest {requestLimit} are shown.</p>
          )}
        </>
      )}
      <RequestSheet
        request={selected}
        deadLetters={read === undefined ? undefined : deadLetters[read.requestID]}
        read={read}
        open={open}
        onOpenChange={setOpen}
        onRefresh={() => {
          if (selected !== undefined) setRead(readOf(selected));
        }}
      />
    </Panel>
  );
}

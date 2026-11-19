import { stageLabels, stageSlugs, type StageName } from '@leads/shared/domain/stages';
import { Button } from '@leads/ui/components/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@leads/ui/components/sheet';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@leads/ui/components/table';
import { cn } from '@leads/ui/lib/utils';
import { ChevronRight, ExternalLink, RefreshCw, Undo2 } from 'lucide-react';
import { Suspense, useDeferredValue, useState } from 'react';

import {
  type CauseBasis,
  type CauseInput,
  type DlqCause,
  type DlqCauseResult,
  type DlqEntry,
  type DlqMessages,
  type DlqResult,
  type Redriven,
  type RedriveResult,
  subjectOf,
} from '#Core/Observation/Domain/dlq';

import { dateTime, fmt, time } from './format';
import { runLogsUrl, s3ObjectUrl } from './links';
import { Loading, SectionError } from './Panel';
import { CopyButton, RunBox, Settled } from './RequestSheet';
import { Tag } from './Tag';

/** One read of the messages of a DLQ. A refresh makes a new read. */
export interface DlqRead {
  readonly stage: StageName;
  readonly result: Promise<DlqResult>;
}

/** Finds the run that failed a message, through the server. */
export type CauseReader = (input: CauseInput) => Promise<DlqCauseResult>;

/** Sends a message back to the main queue of its stage, through the server. */
export type Redrive = (stage: StageName, messageId: string) => Promise<RedriveResult>;

type RedriveState =
  | { readonly kind: 'sending' }
  | { readonly kind: 'done'; readonly redriven: Redriven }
  | { readonly kind: 'failed'; readonly error: string };

/**
 * The messages of the DLQ of one stage in a sheet at the side of the page: a table with one row for each message. A
 * row opens to show the run that failed the message, and the message as plain JSON. The messages load when the sheet
 * opens and when the person refreshes them. The run loads when its row first opens. Each row can send its message back
 * to the main queue of the stage.
 */
export function DlqSheet({
  read,
  open,
  onOpenChange,
  onRefresh,
  readCause,
  redrive,
}: {
  readonly read: DlqRead | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefresh: () => void;
  readonly readCause: CauseReader;
  readonly redrive: Redrive;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[760px]">
        {read !== undefined && (
          <Details key={read.stage} read={read} onRefresh={onRefresh} readCause={readCause} redrive={redrive} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function Details({
  read,
  onRefresh,
  readCause,
  redrive,
}: {
  readonly read: DlqRead;
  readonly onRefresh: () => void;
  readonly readCause: CauseReader;
  readonly redrive: Redrive;
}) {
  // While a refresh loads, the sheet keeps the last read.
  const shown = useDeferredValue(read.result);
  const loading = shown !== read.result;
  return (
    <>
      <SheetHeader className="gap-2 border-b px-5 py-5 pr-14 md:px-7">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              DLQ · {stageLabels[read.stage]}
            </p>
            <SheetTitle className="mt-1 font-mono text-[15px] font-semibold break-all">
              {stageSlugs[read.stage]}-dlq
            </SheetTitle>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="flex-none rounded-lg"
            disabled={loading}
            onClick={onRefresh}
            title="Read the messages again"
          >
            <RefreshCw className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
            Refresh
          </Button>
        </div>
        <SheetDescription>
          The read leaves each message in the queue. Each read adds 1 to the receive count of a message. A redrive sends
          a message back to the queue of the stage and deletes it from the DLQ.
        </SheetDescription>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto px-5 py-5 md:px-7">
        <Suspense fallback={<Loading rows={6} />}>
          <Settled promise={shown}>
            {(result) =>
              result.ok ? (
                <Messages dlq={result.dlq} readCause={readCause} redrive={redrive} />
              ) : (
                <SectionError error={result.error} />
              )
            }
          </Settled>
        </Suspense>
      </div>
    </>
  );
}

function Messages({
  dlq,
  readCause,
  redrive,
}: {
  readonly dlq: DlqMessages;
  readonly readCause: CauseReader;
  readonly redrive: Redrive;
}) {
  const { messages, approximateCount } = dlq;
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  // Each search costs log requests, so a row searches when it first opens, and again only when the person asks.
  const [causes, setCauses] = useState<ReadonlyMap<string, Promise<DlqCauseResult>>>(new Map());
  const [redrives, setRedrives] = useState<ReadonlyMap<string, RedriveState>>(new Map());
  if (messages.length === 0) {
    return <p className="py-6 text-center text-muted-foreground">The DLQ has no messages.</p>;
  }
  const search = (entry: DlqEntry) => {
    if (entry.receivedAt === undefined) return;
    const result = readCause({
      stage: dlq.stage,
      messageId: entry.message.messageId,
      receivedAt: entry.receivedAt,
      requestIDs: entry.requestIDs,
    });
    setCauses((known) => new Map(known).set(entry.message.messageId, result));
  };
  const setRedrive = (messageId: string, state: RedriveState) =>
    setRedrives((known) => new Map(known).set(messageId, state));
  const send = async (messageId: string) => {
    setRedrive(messageId, { kind: 'sending' });
    const result = await redrive(dlq.stage, messageId);
    setRedrive(
      messageId,
      result.ok ? { kind: 'done', redriven: result.redriven } : { kind: 'failed', error: result.error }
    );
  };
  const toggle = (entry: DlqEntry) => {
    const { messageId } = entry.message;
    if (!openRows.has(messageId) && !causes.has(messageId)) search(entry);
    setOpenRows((rows) => {
      const next = new Set(rows);
      if (!next.delete(messageId)) next.add(messageId);
      return next;
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        <span title={dlq.queueName}>{dlq.queueName}</span> · read at <span title={dlq.readAt}>{time(dlq.readAt)}</span>{' '}
        · {fmt(messages.length)} of about {fmt(Math.max(approximateCount, messages.length))}{' '}
        {approximateCount === 1 ? 'message' : 'messages'}
      </p>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-8" />
            <TableHead className="w-44 text-muted-foreground">Sent</TableHead>
            <TableHead className="w-20 text-right text-muted-foreground">Receives</TableHead>
            <TableHead className="text-muted-foreground">Subject</TableHead>
            <TableHead className="w-40">
              <span className="sr-only">Redrive</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {messages.map((entry) => (
            <MessageRow
              key={entry.message.messageId}
              entry={entry}
              place={dlq}
              cause={causes.get(entry.message.messageId)}
              open={openRows.has(entry.message.messageId)}
              onToggle={() => toggle(entry)}
              onSearch={() => search(entry)}
              redrive={redrives.get(entry.message.messageId)}
              onRedrive={() => void send(entry.message.messageId)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function MessageRow({
  entry,
  place,
  cause,
  open,
  onToggle,
  onSearch,
  redrive,
  onRedrive,
}: {
  readonly entry: DlqEntry;
  readonly place: Pick<DlqMessages, 'deployment' | 'region'>;
  readonly cause: Promise<DlqCauseResult> | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onSearch: () => void;
  readonly redrive: RedriveState | undefined;
  readonly onRedrive: () => void;
}) {
  const { message } = entry;
  const sent = message.attributes.SentTimestamp;
  const sentAt = sent === undefined ? undefined : new Date(Number(sent)).toISOString();
  const subject = subjectOf(message);
  const json = JSON.stringify(message, null, 2);
  return (
    <>
      <TableRow
        className={cn('cursor-pointer', redrive?.kind === 'done' && 'text-muted-foreground')}
        data-state={open ? 'selected' : undefined}
        onClick={onToggle}
      >
        <TableCell className="px-1">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide the details of the message' : 'Show the details of the message'}
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn('size-4 transition-transform motion-reduce:transition-none', open && 'rotate-90')}
            />
          </button>
        </TableCell>
        <TableCell title={sentAt}>{dateTime(sentAt)}</TableCell>
        <TableCell className="text-right tabular-nums">{message.attributes.ApproximateReceiveCount ?? '?'}</TableCell>
        <TableCell className="font-mono text-xs">
          <span className="flex items-center gap-1.5">
            <span className="truncate" title={subject}>
              {subject}
            </span>
            {entry.objects.map(({ bucket, key }) => {
              const url = s3ObjectUrl(place, bucket, key);
              return (
                url !== undefined && (
                  <a
                    key={`${bucket}/${key}`}
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open s3://${bucket}/${key} in the S3 console`}
                    aria-label={`Open ${key} in the S3 console`}
                    onClick={(event) => event.stopPropagation()}
                    className="inline-flex flex-none items-center gap-1 rounded-md px-1 py-0.5 font-sans text-muted-foreground outline-none hover:bg-muted hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    S3 <ExternalLink className="size-3" />
                  </a>
                )
              );
            })}
          </span>
        </TableCell>
        <TableCell className="text-right">
          <RedriveControl state={redrive} onRedrive={onRedrive} />
        </TableCell>
      </TableRow>
      {redrive?.kind === 'failed' && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="bg-crit-soft/60 py-1.5 text-xs whitespace-normal text-crit">
            The redrive failed: {redrive.error}
          </TableCell>
        </TableRow>
      )}
      {open && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="p-0 whitespace-normal">
            <div className="m-2 flex flex-col gap-3">
              <Cause entry={entry} result={cause} onSearch={onSearch} />
              <div className="rounded-xl border bg-card">
                <div className="flex items-center gap-2 border-b px-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    {message.messageId}
                  </span>
                  <CopyButton text={json} label="Copy the message as JSON" withText />
                </div>
                <pre className="px-3 py-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                  {json}
                </pre>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * The redrive of one message. A redrive cannot be undone, so the first click asks to confirm it. A message that went
 * back to its queue stays in the table until the next read, as redriven.
 */
function RedriveControl({
  state,
  onRedrive,
}: {
  readonly state: RedriveState | undefined;
  readonly onRedrive: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const click = (action: () => void) => (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    action();
  };
  if (state?.kind === 'done') {
    return (
      <Tag tone="ok" title={`Sent to ${state.redriven.queueName} as ${state.redriven.sentMessageId}`}>
        redriven
      </Tag>
    );
  }
  if (state?.kind === 'sending') {
    return (
      <Button variant="outline" size="sm" className="h-7 rounded-lg text-xs" disabled>
        <RefreshCw className="animate-spin motion-reduce:animate-none" />
        Sending
      </Button>
    );
  }
  if (confirming) {
    return (
      <span className="inline-flex gap-1">
        <Button
          size="sm"
          className="h-7 rounded-lg bg-foreground text-xs text-background hover:bg-foreground/85"
          onClick={click(() => {
            setConfirming(false);
            onRedrive();
          })}
          title="Send the message back to its queue, and delete it from the DLQ"
        >
          Confirm
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 rounded-lg text-xs"
          onClick={click(() => setConfirming(false))}
        >
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 rounded-lg text-xs"
      onClick={click(() => setConfirming(true))}
      title="Send the message back to the queue of its stage"
    >
      <Undo2 />
      {state?.kind === 'failed' ? 'Try again' : 'Redrive'}
    </Button>
  );
}

/** The run that failed a message, as the logs show it. */
function Cause({
  entry,
  result,
  onSearch,
}: {
  readonly entry: DlqEntry;
  readonly result: Promise<DlqCauseResult> | undefined;
  readonly onSearch: () => void;
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-xl border bg-muted/30 p-3">
      <div className="flex items-center gap-2">
        <h4 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Cause</h4>
        {result !== undefined && <SearchAgain result={result} onSearch={onSearch} />}
      </div>
      {result === undefined ? (
        <p className="text-xs text-muted-foreground">
          The message has no receive time, so the lab cannot search the logs for its run.
        </p>
      ) : (
        <CauseResult result={result} entry={entry} />
      )}
    </section>
  );
}

function SearchAgain({
  result,
  onSearch,
}: {
  readonly result: Promise<DlqCauseResult>;
  readonly onSearch: () => void;
}) {
  const shown = useDeferredValue(result);
  const loading = shown !== result;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="ml-auto h-7 rounded-lg text-xs"
      disabled={loading}
      onClick={onSearch}
      title="Search the logs again"
    >
      <RefreshCw className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
      Search again
    </Button>
  );
}

function CauseResult({ result, entry }: { readonly result: Promise<DlqCauseResult>; readonly entry: DlqEntry }) {
  // While a new search loads, the part keeps the last result.
  const shown = useDeferredValue(result);
  return (
    <Suspense fallback={<Loading rows={3} />}>
      <Settled promise={shown}>
        {(read) => (read.ok ? <CauseView cause={read.cause} entry={entry} /> : <SectionError error={read.error} />)}
      </Settled>
    </Suspense>
  );
}

const basisText = (basis: CauseBasis) =>
  basis.kind === 'message'
    ? 'A line of this run names the message.'
    : basis.kind === 'request'
      ? `No line names the message. This is the failed run of request ${basis.requestID} that started nearest to the receive.`
      : 'No line names the message or its request. This is the failed run that started nearest to the receive.';

function CauseView({ cause, entry }: { readonly cause: DlqCause; readonly entry: DlqEntry }) {
  const [logsOpen, setLogsOpen] = useState(true);
  const { found } = cause;
  if (found === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        No run in the logs fits this message. The search covered {dateTime(cause.from)} to {time(cause.to)} in{' '}
        <span className="font-mono">{cause.logGroup}</span>.
      </p>
    );
  }
  const { basis, run, candidates } = found;
  const exact = basis.kind === 'message';
  return (
    <>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Tag tone={exact ? 'ok' : 'warning'}>{exact ? 'exact' : 'approximate'}</Tag>
        <span>
          {basisText(basis)}
          {!exact && candidates > 1 && ` ${fmt(candidates)} failed runs started near the receive.`}
        </span>
      </p>
      <RunBox
        run={run}
        requestID={basis.kind === 'request' ? basis.requestID : (entry.requestIDs[0] ?? '')}
        receivedAt={undefined}
        logsUrl={runLogsUrl(cause, cause.logGroup, run.logStream, run.runID)}
        logsOpen={logsOpen}
        focused={false}
        onLogs={setLogsOpen}
      />
    </>
  );
}

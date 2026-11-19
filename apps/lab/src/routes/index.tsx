import { Alert, AlertDescription, AlertTitle } from '@leads/ui/components/alert';
import { Button } from '@leads/ui/components/button';
import { Card } from '@leads/ui/components/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@leads/ui/components/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@leads/ui/components/tabs';
import { cn } from '@leads/ui/lib/utils';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { CircleAlert, Clock, RefreshCw } from 'lucide-react';
import { type ReactNode, Suspense, use, useDeferredValue } from 'react';

import type { DetailsResult } from '#Core/Observation/Domain/details';
import type { DlqCauseResult, DlqResult, RedriveResult } from '#Core/Observation/Domain/dlq';
import { assessmentOf } from '#Core/Observation/Domain/health';
import type { Levels, LevelsResult } from '#Core/Observation/Domain/levels';
import type { Snapshot } from '#Core/Observation/Domain/snapshot';
import { metricsCompleteAt, toWindowHours, windowChoices, type WindowHours } from '#Core/Observation/Domain/time';
import { readDlq, readDlqCause, redriveDlqMessage } from '#Entrypoints/Lab/dlq';
import { readLevels } from '#Entrypoints/Lab/levels';
import { readRuns } from '#Entrypoints/Lab/runs';
import { readStatus, type StatusResult } from '#Entrypoints/Lab/status';

import { Costs } from '../UI/Costs';
import { type DlqReader, Flow } from '../UI/Flow';
import { fmt, time } from '../UI/format';
import { type FeedState, lastChangeOf } from '../UI/requestFeed';
import { Requests, type RunsReader } from '../UI/Requests';
import { Buckets, Handlers, logLimit, Logs, Queues, RuntimeSettings, Stack } from '../UI/Resources';
import { type LevelsReader, useLevels } from '../UI/useLevels';
import { useRequestFeed } from '../UI/useRequestFeed';

const sectionNames = [
  'deploymentStatus',
  'handlers',
  'queues',
  'buckets',
  'orders',
  'settings',
  'logs',
  'usage',
] as const;

const failure = (
  error: unknown
): StatusResult & DetailsResult & DlqResult & DlqCauseResult & RedriveResult & LevelsResult => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
});

const runsOf: RunsReader = (requestID) => readRuns({ data: { requestID } }).catch(failure);

const dlqOf: DlqReader = {
  messages: (stage) => readDlq({ data: { stage } }).catch(failure),
  cause: (input) => readDlqCause({ data: input }).catch(failure),
  redrive: (stage, messageId) => redriveDlqMessage({ data: { stage, messageId } }).catch(failure),
};

const levelsOf: LevelsReader = () => readLevels().catch(failure);

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { readonly hours: WindowHours } => ({
    hours: toWindowHours(search.hours),
  }),
  loaderDeps: ({ search }) => ({ hours: search.hours }),
  // The loader does not wait for the snapshot, so that the page and the live requests show at once.
  loader: ({ deps }) => ({ status: readStatus({ data: { hours: deps.hours } }).catch(failure) }),
  component: Monitor,
});

/**
 * A dashboard of the deployed leads workflow. The resources load when the page opens, when the window changes, and
 * when the person refreshes them, because each snapshot costs CloudWatch metric requests. The request ledger is live.
 */
function Monitor() {
  const { hours } = Route.useSearch();
  const { status } = Route.useLoaderData();
  // While a new snapshot loads, the page keeps the last one.
  const shown = useDeferredValue(status);
  const { state: feed, setPaused } = useRequestFeed();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const { levels, watching, watch } = useLevels(levelsOf);
  // A redrive moves messages and objects, so the page watches the counts until the pipeline is quiet.
  const readDlq: DlqReader = {
    ...dlqOf,
    redrive: async (stage, messageId) => {
      const result = await dlqOf.redrive(stage, messageId);
      if (result.ok) watch();
      return result;
    },
  };

  const page = (result: StatusResult | undefined) => (
    <Page
      result={result}
      feed={feed}
      hours={hours}
      loading={result === undefined || shown !== status}
      levels={levels}
      watching={watching}
      readDlq={readDlq}
      onRefresh={() => void router.invalidate()}
      onPause={setPaused}
      onWindow={(next) => void navigate({ search: { hours: next } })}
    />
  );

  return (
    <Suspense fallback={page(undefined)}>
      <Settled promise={shown}>{page}</Settled>
    </Suspense>
  );
}

function Settled<T>({
  promise,
  children,
}: {
  readonly promise: Promise<T>;
  readonly children: (value: T) => ReactNode;
}) {
  return children(use(promise));
}

function Page({
  result,
  feed,
  hours,
  loading,
  levels,
  watching,
  readDlq,
  onRefresh,
  onWindow,
  onPause,
}: {
  /** No result while the first snapshot loads. */
  readonly result: StatusResult | undefined;
  readonly feed: FeedState;
  readonly hours: WindowHours;
  readonly loading: boolean;
  /** Counts that are newer than the snapshot, which the page puts on it. */
  readonly levels: Levels | undefined;
  readonly watching: boolean;
  readonly readDlq: DlqReader;
  readonly onRefresh: () => void;
  readonly onWindow: (hours: WindowHours) => void;
  readonly onPause: (paused: boolean) => void;
}) {
  // Newer counts can change the snapshot and its findings.
  const status =
    result?.ok !== true ? undefined : levels === undefined ? result : assessmentOf(result.snapshot, levels);
  const snapshot = status?.snapshot;
  const countsAt = status?.countsAt;
  const deadLetters = result?.ok === true && result.deadLetters.ok ? result.deadLetters.value : undefined;
  const requests = (
    <Requests
      feed={feed}
      {...(deadLetters !== undefined && { deadLetters })}
      windowHours={hours}
      readRuns={runsOf}
      onPause={onPause}
    />
  );
  const lastChange = lastChangeOf(feed);
  const completeAt = snapshot === undefined ? undefined : metricsCompleteAt(snapshot.collectedAt, lastChange);
  return (
    <main className="mx-auto flex max-w-[1320px] flex-col gap-6 px-4 py-6 md:px-6 md:py-7">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-tight">Leads lab</h1>
          <p className="mt-0.5 min-h-5 text-muted-foreground">
            {snapshot !== undefined && (
              <>
                {snapshot.deployment} · {snapshot.region} ·{' '}
                <span title={snapshot.collectedAt}>read at {time(snapshot.collectedAt)}</span>
                {countsAt !== undefined && (
                  <span title="The counts of the queues and the buckets are newer than the snapshot">
                    {' '}
                    · counts at {time(countsAt)}
                  </span>
                )}
                {watching && (
                  <span className="ml-2 inline-flex items-center gap-1.5 text-live">
                    <span className="size-1.5 animate-pulse rounded-full bg-live motion-reduce:animate-none" />
                    watching the counts
                  </span>
                )}
              </>
            )}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex h-10 items-center rounded-[10px] border bg-card pl-3">
            <span className="text-muted-foreground">Window</span>
            <Select value={String(hours)} onValueChange={(value) => onWindow(toWindowHours(value))}>
              <SelectTrigger
                aria-label="Time window"
                className="h-9 border-0 bg-transparent font-semibold shadow-none dark:bg-transparent dark:hover:bg-transparent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {windowChoices.map((choice) => (
                  <SelectItem key={choice} value={String(choice)}>
                    Last {choice} h
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            className="h-10 rounded-[10px] bg-foreground px-4 font-bold text-background hover:bg-foreground/85"
            disabled={loading}
            onClick={onRefresh}
          >
            <RefreshCw className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
            Refresh
          </Button>
        </div>
      </header>
      {result?.ok === false ? (
        <>
          <Problem title="Cannot load the status">{result.error}</Problem>
          {requests}
        </>
      ) : (
        <>
          {snapshot !== undefined && sectionNames.every((name) => !snapshot[name].ok) && (
            <Problem title="No section could be read">
              If the AWS session expired, sign in to AWS again and refresh.
            </Problem>
          )}
          {snapshot !== undefined && lastChange !== undefined && completeAt !== undefined && (
            <Incomplete lastChange={lastChange} collectedAt={snapshot.collectedAt} completeAt={completeAt} />
          )}
          <Flow
            snapshot={snapshot}
            findings={status?.findings}
            overall={status?.overall}
            windowHours={hours}
            readDlq={readDlq}
          />
          {requests}
          <Costs snapshot={snapshot} windowHours={hours} feed={feed} />
          <Details snapshot={snapshot} />
        </>
      )}
    </main>
  );
}

function Problem({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Alert variant="destructive" className="border-crit/30 bg-crit-soft">
      <CircleAlert />
      <AlertTitle className="text-crit">{title}</AlertTitle>
      <AlertDescription className="text-crit">{children}</AlertDescription>
    </Alert>
  );
}

/** The snapshot is older than the metrics of the last activity, so its runs, messages, and writes can be too low. */
function Incomplete({
  lastChange,
  collectedAt,
  completeAt,
}: {
  readonly lastChange: string;
  readonly collectedAt: string;
  readonly completeAt: string;
}) {
  return (
    <Alert className="border-warn/30 bg-warn-soft">
      <Clock />
      <AlertTitle className="text-warn">The metrics can be incomplete</AlertTitle>
      <AlertDescription className="text-warn">
        The ledger changed at {time(lastChange)}, and this snapshot was read at {time(collectedAt)}. CloudWatch
        publishes metrics some minutes after the activity, so the runs, messages, and writes can be too low. Refresh
        after {time(completeAt)}.
      </AlertDescription>
    </Alert>
  );
}

/** A count next to the name of a tab. It shows only when it is not 0, so a quiet tab stays quiet. */
function Count({ value, capped = false }: { readonly value: number | undefined; readonly capped?: boolean }) {
  if (value === undefined || value === 0) return null;
  return (
    <span className="rounded-full bg-warn-soft px-1.5 text-xs font-semibold text-warn">
      {fmt(value)}
      {capped && '+'}
    </span>
  );
}

/** A tab with a line under it when it is active. */
const Tab = ({ value, children }: { readonly value: string; readonly children: ReactNode }) => (
  <TabsTrigger
    value={value}
    className="h-11 flex-none rounded-none border-0 border-b-2 border-transparent px-3.5 font-semibold text-muted-foreground data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none dark:data-[state=active]:border-foreground dark:data-[state=active]:bg-transparent"
  >
    {children}
  </TabsTrigger>
);

/** The resources of the stack, one tab for each kind. The flow above has the numbers that matter most. */
function Details({ snapshot }: { readonly snapshot: Snapshot | undefined }) {
  const waiting =
    snapshot?.buckets.ok === true
      ? snapshot.buckets.value.reduce((sum, bucket) => sum + bucket.objects.length, 0)
      : undefined;
  const logs = snapshot?.logs.ok === true ? snapshot.logs.value.length : undefined;
  return (
    <Card className="rounded-2xl pt-2 pb-5 shadow-none">
      <Tabs defaultValue="handlers" className="gap-4 px-4 md:px-6">
        <div className="-mx-4 overflow-x-auto border-b px-4 md:-mx-6 md:px-6">
          <TabsList className="h-auto rounded-none bg-transparent p-0">
            <Tab value="handlers">Handlers</Tab>
            <Tab value="queues">Queues</Tab>
            <Tab value="buckets">
              Buckets <Count value={waiting} />
            </Tab>
            <Tab value="logs">
              Logs <Count value={logs} capped={logs !== undefined && logs >= logLimit} />
            </Tab>
            <Tab value="settings">Runtime settings</Tab>
            <Tab value="stack">Stack</Tab>
          </TabsList>
        </div>
        <TabsContent value="handlers">
          <Handlers snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="queues">
          <Queues snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="buckets">
          <Buckets snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="logs">
          <Logs snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="settings">
          <RuntimeSettings snapshot={snapshot} />
        </TabsContent>
        <TabsContent value="stack">
          <Stack snapshot={snapshot} />
        </TabsContent>
      </Tabs>
    </Card>
  );
}

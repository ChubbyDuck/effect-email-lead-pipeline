/**
 * What one request cost, from its runs as the logs show them. Each run has its billed time and memory in its REPORT
 * line, and each progress write is a log line, so the logs give the Lambda time, the ledger writes, the attachments
 * that the inbox stored, the leads that a source pushed, and the leads that a lead run took for the request. The
 * other calls of a stage follow from these counts, as the handlers make them. The size lines give the bytes of the
 * email and of each source, so the SES chunks and the S3 storage are measured.
 */
import {
  addSplits,
  gbSecondsOf,
  gigabytesOf,
  type Service,
  sesChunksOf,
  type ServiceSplit,
} from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';
import { QueueBatchSize } from '@leads/shared/domain/queueLimits';
import type { StageName } from '@leads/shared/domain/stages';

import { monthHours } from './costs';
import type { HandlerRun } from './runs';
import { type FileRecord, filesOf, runTrailOf } from './trail';

/** In ms. S3 bills the storage by the hour, over a month of the projection. */
const monthMs = monthHours * 3_600_000;

/** One part of a cost: a quantity at a unit price of one service. */
export interface CostTerm {
  readonly service: Service;
  /** What the quantity counts, such as `calls` or `ledger writes`. */
  readonly item: string;
  readonly quantity: number;
  readonly unit: string;
  readonly unitPrice: number;
  readonly cost: number;
  /** How the logs give the quantity, when they do not count it directly. */
  readonly note?: string;
}

export interface StageCost {
  readonly stage: StageName;
  readonly runs: number;
  /** In ms after the start of the request: the end of the last run of the stage. No end while a run still runs. */
  readonly endMs?: number;
  readonly terms: readonly CostTerm[];
  readonly cost: number;
  readonly services: ServiceSplit;
}

export interface RequestCost {
  readonly stages: readonly StageCost[];
  /** In ms: from the start of the request to the end of its last run. */
  readonly endMs?: number;
  readonly cost: number;
  readonly services: ServiceSplit;
  /** Runs without a REPORT line yet. Their time is not in the cost. */
  readonly unbilledRuns: number;
}

export interface RequestFacts {
  readonly requestID: string;
  /** When S3 stored the email. A standalone source has none, so SES did not receive it. */
  readonly receivedAt?: string;
  /** The attachments that the inbox handler counted, from the ledger entry. */
  readonly attachments?: number;
}

/** The files of a request that the runs read, and when the inbox stored the sources. */
interface RequestFiles {
  readonly email?: FileRecord;
  readonly sources: readonly FileRecord[];
  /** In ms since the epoch: the time of the last attachments count of the inbox. The stores follow it. */
  readonly sourcesStoredAt?: number;
}

const term = (fields: Omit<CostTerm, 'cost'>): CostTerm => ({ ...fields, cost: fields.quantity * fields.unitPrice });

export function splitOf(terms: readonly CostTerm[]): ServiceSplit {
  const split: ServiceSplit = {};
  for (const { service, cost } of terms) if (cost > 0) split[service] = (split[service] ?? 0) + cost;
  return split;
}

const sumOf = <T>(items: readonly T[], value: (item: T) => number) =>
  items.reduce((total, item) => total + value(item), 0);

/** The progress changes of the request that the runs wrote, in order. */
const changesOf = (runs: readonly HandlerRun[], requestID: string) =>
  runs.flatMap((run) => runTrailOf(run, requestID).changes.map(({ change }) => change));

const gbSecondsOfRun = (run: HandlerRun) =>
  run.billedMs === undefined || run.memoryMb === undefined ? 0 : gbSecondsOf(run.billedMs, run.memoryMb);

const billed = (run: HandlerRun) => run.billedMs !== undefined && run.memoryMb !== undefined;

const bytesText = (bytes: number) => `${bytes.toLocaleString('en-US')} bytes`;

/** In GB-months: the bytes of each file × the time from its store to its delete. A file not deleted yet has no term. */
const storageOf = (files: readonly FileRecord[], storedAt: (file: FileRecord) => number) =>
  files.reduce(
    (total, file) =>
      file.endedAt === undefined
        ? total
        : total + gigabytesOf(file.bytes) * (Math.max(0, Date.parse(file.endedAt) - storedAt(file)) / monthMs),
    0
  );

const ledgerWritesNote = 'An entry is less than 1 KB, so each write is one write unit.';
const sharedNote =
  'A lead run takes the leads of other requests too, so this request pays its leads over all leads of the run.';

/** The Lambda calls and the billed GB-seconds of the runs, and the log lines that the runs wrote. */
function runTerms(runs: readonly HandlerRun[], share: (run: HandlerRun) => number, shared: boolean): CostTerm[] {
  const note = shared ? sharedNote : undefined;
  const memories = [...new Set(runs.flatMap((run) => (run.memoryMb === undefined ? [] : [run.memoryMb])))];
  return [
    term({
      service: 'Lambda',
      item: 'calls',
      quantity: sumOf(runs, (run) => (billed(run) ? share(run) : 0)),
      unit: 'call',
      unitPrice: prices.lambdaRequest,
      ...(note !== undefined && { note }),
    }),
    term({
      service: 'Lambda',
      item: memories.length === 1 ? `billed time at ${memories[0]} MB` : 'billed time',
      quantity: sumOf(runs, (run) => gbSecondsOfRun(run) * share(run)),
      unit: 'GB-s',
      unitPrice: prices.lambdaGbSecond,
      note: `The billed duration of each run, with the init time of a cold start, × its memory.${note === undefined ? '' : ` ${note}`}`,
    }),
    term({
      service: 'CloudWatch Logs',
      item: 'log lines taken in',
      quantity: sumOf(runs, (run) => gigabytesOf(run.logBytes * share(run))),
      unit: 'GB',
      unitPrice: prices.logIngestGb,
      ...(note !== undefined && { note }),
    }),
    term({
      service: 'CloudWatch Logs',
      item: 'log lines kept one month',
      quantity: sumOf(runs, (run) => gigabytesOf(run.logBytes * share(run))),
      unit: 'GB-month',
      unitPrice: prices.logStorageGbMonth,
      note: `The log groups keep the lines with no end, so each later month adds the same storage again.${note === undefined ? '' : ` ${note}`}`,
    }),
  ];
}

/** The calls of a queue that triggers one stage: one receive for each run, and one delete for each run that ended. */
function triggerTerms(runs: readonly HandlerRun[], share: (run: HandlerRun) => number, shared: boolean): CostTerm[] {
  const ended = (run: HandlerRun) => (run.outcome === 'ended' ? share(run) : 0);
  const note = shared ? `One receive and one delete take the whole batch. ${sharedNote}` : undefined;
  return [
    term({
      service: 'SQS',
      item: 'receives',
      quantity: sumOf(runs, share),
      unit: 'call',
      unitPrice: prices.sqsRequest,
      note: note ?? 'One for each run: the queue gives one message for each receive.',
    }),
    term({
      service: 'SQS',
      item: 'deletes',
      quantity: sumOf(runs, ended),
      unit: 'call',
      unitPrice: prices.sqsRequest,
      note:
        note ?? 'One for each run that ended. The message of a failed run goes back to the queue for the next receive.',
    }),
  ];
}

function ledgerTerm(writes: number, note = ledgerWritesNote): CostTerm {
  return term({
    service: 'DynamoDB',
    item: 'ledger writes',
    quantity: writes,
    unit: 'write unit',
    unitPrice: prices.dynamoWriteUnit,
    note,
  });
}

function inboxTerms(facts: RequestFacts, runs: readonly HandlerRun[], files: RequestFiles): CostTerm[] {
  const email = facts.receivedAt !== undefined || runs.length > 0 ? 1 : 0;
  const counted = runs.flatMap((run) => runTrailOf(run, facts.requestID).attachments ?? []);
  const puts = counted.length > 0 ? sumOf(counted, (count) => count) : (facts.attachments ?? 0);
  const progressWrites = changesOf(runs, facts.requestID).length;
  return [
    term({ service: 'SES', item: 'email received', quantity: email, unit: 'email', unitPrice: prices.sesEmail }),
    sesChunksTerm(email, files.email),
    term({ service: 'S3', item: 'PUT of the email, by SES', quantity: email, unit: 'call', unitPrice: prices.s3Put }),
    term({
      service: 'SQS',
      item: 'sends: the notification of the email',
      quantity: email,
      unit: 'call',
      unitPrice: prices.sqsRequest,
    }),
    ...triggerTerms(runs, () => 1, false),
    ...runTerms(runs, () => 1, false),
    term({
      service: 'S3',
      item: 'GET of the email',
      quantity: runs.length,
      unit: 'call',
      unitPrice: prices.s3Get,
      note: 'One for each run.',
    }),
    term({
      service: 'S3',
      item: 'PUT of the sources',
      quantity: puts,
      unit: 'call',
      unitPrice: prices.s3Put,
      note: 'One for each attachment that a run counted. A DELETE of the email is free.',
    }),
    ledgerTerm(
      runs.length + progressWrites,
      `One acknowledgement for each run and one write for each progress line. ${ledgerWritesNote}`
    ),
    term({
      service: 'S3',
      item: 'storage of the email',
      quantity:
        files.email === undefined
          ? 0
          : storageOf([files.email], (file) =>
              facts.receivedAt === undefined ? Date.parse(file.readAt) : Date.parse(facts.receivedAt)
            ),
      unit: 'GB-month',
      unitPrice: prices.s3StorageGbMonth,
      note: 'The size of the email × the time from the PUT by SES to the end of the inbox run that deleted it.',
    }),
  ];
}

/** SES bills each started chunk of 256 KB. Without the size of the email, the term is one chunk: a minimum. */
function sesChunksTerm(emails: number, file: FileRecord | undefined): CostTerm {
  const fields = { service: 'SES', item: 'chunks of 256 KB', unit: 'chunk', unitPrice: prices.sesChunk } as const;
  if (file === undefined || emails === 0)
    return term({
      ...fields,
      quantity: emails,
      note: 'The logs do not give the size of the email, so this is one chunk: a minimum.',
    });
  const chunks = sesChunksOf(file.bytes);
  return term({
    ...fields,
    quantity: chunks,
    note: `The email is ${bytesText(file.bytes)}, so it is ${chunks} ${chunks === 1 ? 'chunk' : 'chunks'} of 256 KB.`,
  });
}

function sourceTerms(facts: RequestFacts, runs: readonly HandlerRun[], files: RequestFiles): CostTerm[] {
  const changes = changesOf(runs, facts.requestID);
  const started = changes.filter(({ sourcesPending }) => (sourcesPending ?? 0) > 0).length;
  const sources = facts.attachments ?? started;
  const leadSends = sumOf(changes, ({ sourcesLeads }) => Math.ceil(Math.max(0, sourcesLeads ?? 0) / QueueBatchSize));
  return [
    term({
      service: 'SQS',
      item: 'sends: the notifications of the sources',
      quantity: sources,
      unit: 'call',
      unitPrice: prices.sqsRequest,
      note: 'One for each source that the inbox stored.',
    }),
    ...triggerTerms(runs, () => 1, false),
    ...runTerms(runs, () => 1, false),
    term({
      service: 'S3',
      item: 'GET of the sources',
      quantity: runs.length,
      unit: 'call',
      unitPrice: prices.s3Get,
      note: 'One for each run. A DELETE of the source is free.',
    }),
    term({
      service: 'SQS',
      item: `sends of the leads, ${QueueBatchSize} in each`,
      quantity: leadSends,
      unit: 'call',
      unitPrice: prices.sqsRequest,
      note: `A run pushes the leads it found in batches of ${QueueBatchSize}. A batch of small leads is less than 64 KB, so it is one call.`,
    }),
    ledgerTerm(changes.length, `One for each progress line. ${ledgerWritesNote}`),
    term({
      service: 'S3',
      item: 'storage of the sources',
      quantity: storageOf(files.sources, (file) => files.sourcesStoredAt ?? Date.parse(file.readAt)),
      unit: 'GB-month',
      unitPrice: prices.s3StorageGbMonth,
      note:
        files.sourcesStoredAt === undefined
          ? 'For each source: its size × the time from its first read to the end of the run that deleted it. No inbox stored it, so the time before the read is not known.'
          : 'For each source: its size × the time from the store by the inbox to the end of the run that deleted it.',
    }),
  ];
}

function leadTerms(facts: RequestFacts, runs: readonly HandlerRun[]): CostTerm[] {
  const trails = new Map(runs.map((run) => [run, runTrailOf(run, facts.requestID)]));
  const share = (run: HandlerRun) => trails.get(run)?.share ?? 1;
  const changes = [...trails.values()].flatMap((trail) => trail.changes);
  const taken = sumOf([...trails.values()], ({ leadsTaken }) => leadsTaken);
  return [
    ...triggerTerms(runs, share, true),
    ...runTerms(runs, share, true),
    term({
      service: 'DynamoDB',
      item: 'order writes',
      quantity: taken,
      unit: 'write unit',
      unitPrice: prices.dynamoWriteUnit,
      note: 'One conditional put for each lead that a run took. A lead is less than 1 KB, so each put is one write unit.',
    }),
    ledgerTerm(changes.length, `One for each progress line of this request. ${ledgerWritesNote}`),
  ];
}

const termsOf: Record<
  StageName,
  (facts: RequestFacts, runs: readonly HandlerRun[], files: RequestFiles) => CostTerm[]
> = {
  inbox: inboxTerms,
  leadSources: sourceTerms,
  leads: leadTerms,
};

/** In ms after `start`: the end of the last run. No end while a run has no end. */
function endOf(runs: readonly HandlerRun[], start: number): number | undefined {
  if (runs.length === 0 || runs.some(({ endedAt }) => endedAt === undefined)) return undefined;
  return Math.max(...runs.map(({ endedAt }) => Date.parse(endedAt!))) - start;
}

/** The email and the sources of the request, from the size lines of all its runs. */
function requestFilesOf(
  requestID: string,
  stages: readonly { readonly stage: StageName; readonly runs: readonly HandlerRun[] }[]
): RequestFiles {
  const files = filesOf(
    stages.flatMap(({ runs }) => runs),
    requestID
  );
  const countedAt = stages
    .filter(({ stage }) => stage === 'inbox')
    .flatMap(({ runs }) => runs.flatMap((run) => runTrailOf(run, requestID).changes))
    .filter(({ change }) => change.attachments !== undefined)
    .map(({ at }) => at);
  const email = files.find(({ kind }) => kind === 'email');
  return {
    ...(email !== undefined && { email }),
    sources: files.filter(({ kind }) => kind === 'source'),
    ...(countedAt.length > 0 && { sourcesStoredAt: Math.max(...countedAt) }),
  };
}

/**
 * The cost of one request, stage by stage. The request starts when the email came in, or at its first run. A stage
 * without runs has no Lambda cost, but the inbox stage still has the receipt of the email.
 */
export function requestCostOf(
  facts: RequestFacts,
  stages: readonly { readonly stage: StageName; readonly runs: readonly HandlerRun[] }[]
): RequestCost {
  const all = stages.flatMap(({ runs }) => runs);
  const starts = all.map(({ startedAt }) => Date.parse(startedAt));
  const start =
    facts.receivedAt === undefined ? Math.min(...starts) : Math.min(Date.parse(facts.receivedAt), ...starts);

  const files = requestFilesOf(facts.requestID, stages);

  const costs = stages.map(({ stage, runs }): StageCost => {
    const terms = termsOf[stage](facts, runs, files).filter(({ quantity }) => quantity > 0);
    const endMs = endOf(runs, start);
    return {
      stage,
      runs: runs.length,
      ...(endMs !== undefined && { endMs }),
      terms,
      cost: terms.reduce((total, { cost }) => total + cost, 0),
      services: splitOf(terms),
    };
  });
  const endMs = endOf(all, start);
  return {
    stages: costs,
    ...(endMs !== undefined && { endMs }),
    cost: costs.reduce((total, { cost }) => total + cost, 0),
    services: addSplits(...costs.map(({ services }) => services)),
    unbilledRuns: all.filter((run) => !billed(run)).length,
  };
}

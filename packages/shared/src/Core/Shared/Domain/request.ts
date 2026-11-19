import { Effect, Schema } from 'effect';

/** How a handler ended its work: done, refused because of its input, or given up on. */
export const Outcome = Schema.Literals(['processed', 'rejected', 'failed']);
export type Outcome = typeof Outcome.Type;

/** Where the email of one request stands in the inbox handler: not yet done, or ended with an outcome. */
export const RequestStatus = Schema.Literals(['pending', ...Outcome.literals]);
export type RequestStatus = typeof RequestStatus.Type;

/**
 * The ID of one request: the SES message ID of its email, or a hash in the same shape. Only `Domain/keys.ts` makes
 * one from a key, so a plain string, such as the ID of a Lambda call, cannot go where a request ID must go.
 */
export const RequestID = Schema.String.pipe(Schema.brand('RequestID'));
export type RequestID = typeof RequestID.Type;

/** The record of one received email, so that every email in the system has a known status. */
export const Request = Schema.Struct({
  requestID: RequestID,
  /** When S3 stored the email. */
  receivedAt: Schema.Date,
  inboxStatus: RequestStatus,
});
export type Request = typeof Request.Type;

/** A request starts as pending when its email comes in. */
export const pendingRequest = (requestID: RequestID, receivedAt: Date): Request => ({
  requestID,
  receivedAt,
  inboxStatus: 'pending',
});

/**
 * The counters of a request entry. Sources and leads have counters, not a status, because one request has many of
 * them. A counter that no change touched is 0.
 */
export const RequestCounters = [
  'sourcesPending',
  'sourcesProcessed',
  'sourcesRejected',
  'sourcesFailed',
  'sourcesLeads',
  'leadsPending',
  'leadsProcessed',
  'leadsRejected',
  'leadsFailed',
] as const;
export type RequestCounter = (typeof RequestCounters)[number];

const Delta = Schema.optionalKey(Schema.Int);

/**
 * One change of a request entry: a new inbox status, the number of attachments, and a delta for each counter. The
 * names are the names of the entry attributes, so the ledger stores a change without a mapping.
 */
export const RequestProgress = Schema.Struct({
  inboxStatus: Schema.optionalKey(RequestStatus),
  attachments: Schema.optionalKey(Schema.Int),
  sourcesPending: Delta,
  sourcesProcessed: Delta,
  sourcesRejected: Delta,
  sourcesFailed: Delta,
  sourcesLeads: Delta,
  leadsPending: Delta,
  leadsProcessed: Delta,
  leadsRejected: Delta,
  leadsFailed: Delta,
});
export type RequestProgress = typeof RequestProgress.Type;

const progressLogLine = /^Progress of request (\S+): (\{.*\})$/;
const decodeProgress = Schema.decodeUnknownOption(Schema.fromJsonString(RequestProgress));

/**
 * The log message of one change. Each Lambda log line also has the ID of its run, so the monitor finds the runs of a
 * request with a search for the request ID in the logs.
 */
export const progressLogMessage = (requestID: RequestID, progress: RequestProgress) =>
  `Progress of request ${requestID}: ${JSON.stringify(progress)}`;

/** The change in a log message of `progressLogMessage`. No change in another message. */
export function progressOfLogMessage(
  message: string
): { readonly requestID: string; readonly progress: RequestProgress } | undefined {
  const match = progressLogLine.exec(message.trim());
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const progress = decodeProgress(match[2]);
  return progress._tag === 'Some' ? { requestID: match[1], progress: progress.value } : undefined;
}

/** The size of one file that a handler read: the email of the request or one of its sources. */
export const FileSize = Schema.Struct({
  kind: Schema.Literals(['email', 'source']),
  /** The S3 key, so that a run that a retry repeats gives the same file again. */
  key: Schema.String,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type FileSize = typeof FileSize.Type;

const fileSizeLogLine = /^File size of request (\S+): (\{.*\})$/;
const decodeFileSize = Schema.decodeUnknownOption(Schema.fromJsonString(FileSize));

/**
 * The log message of the size of one file. The logs do not give the size of an email in another way, so the CloudWatch
 * reader of the monitor gets the SES chunks and the S3 storage from this message.
 */
export const fileSizeLogMessage = (requestID: RequestID, size: FileSize) =>
  `File size of request ${requestID}: ${JSON.stringify({ kind: size.kind, key: size.key, bytes: size.bytes })}`;

/** The size in a log message of `fileSizeLogMessage`. No size in another message. */
export function fileSizeOfLogMessage(
  message: string
): { readonly requestID: string; readonly size: FileSize } | undefined {
  const match = fileSizeLogLine.exec(message.trim());
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  const size = decodeFileSize(match[2]);
  return size._tag === 'Some' ? { requestID: match[1], size: size.value } : undefined;
}

/** A counter that no change touched is absent from the stored entry, so it reads as 0. */
const Counter = Schema.Int.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)));

/**
 * The entry of one request in the ledger. The stored item has the same flat shape, with its dates as ISO strings, so
 * this schema reads the item without a mapping. An entry that a source handler made before the acknowledgement, such
 * as one for a manual upload, has no `receivedAt`, no `inboxStatus`, and no `attachments`.
 */
export const RequestEntry = Schema.Struct({
  requestID: RequestID,
  receivedAt: Schema.optionalKey(Schema.DateFromString),
  updatedAt: Schema.DateFromString,
  inboxStatus: Schema.optionalKey(RequestStatus),
  attachments: Schema.optionalKey(Schema.Int),
  sourcesPending: Counter,
  sourcesProcessed: Counter,
  sourcesRejected: Counter,
  sourcesFailed: Counter,
  sourcesLeads: Counter,
  leadsPending: Counter,
  leadsProcessed: Counter,
  leadsRejected: Counter,
  leadsFailed: Counter,
});
export type RequestEntry = typeof RequestEntry.Type;

/**
 * The sources that wait in the queue: the attachments that no source handler took yet. It is not known before the
 * inbox handler counts the attachments.
 */
export const sourcesInQueue = (entry: RequestEntry): number | undefined =>
  entry.attachments === undefined
    ? undefined
    : entry.attachments - (entry.sourcesPending + entry.sourcesProcessed + entry.sourcesRejected + entry.sourcesFailed);

/** The leads that wait in the queue: the leads that the sources found and that no lead handler took yet. */
export const leadsInQueue = (entry: RequestEntry): number =>
  entry.sourcesLeads - (entry.leadsPending + entry.leadsProcessed + entry.leadsRejected + entry.leadsFailed);

const sourceCounterOf = {
  processed: 'sourcesProcessed',
  rejected: 'sourcesRejected',
  failed: 'sourcesFailed',
} as const satisfies Record<Outcome, RequestCounter>;

/** A delta of 0 changes nothing, so a change keeps only the counters that move. */
const moving = (deltas: Partial<Record<RequestCounter, number>>): RequestProgress =>
  Object.fromEntries(Object.entries(deltas).filter(([, delta]) => delta !== 0));

/** The inbox handler ended its work on the email. */
export const inboxEnded = (status: Outcome): RequestProgress => ({ inboxStatus: status });

/** The inbox handler knows how many sources the email gives. */
export const attachmentsCounted = (attachments: number): RequestProgress => ({ attachments });

/** A source handler took one source. */
export const sourceStarted = (): RequestProgress => ({ sourcesPending: 1 });

/** A source handler found the valid leads of its source, before it pushes them. */
export const sourceFoundLeads = (leads: number): RequestProgress => ({ sourcesLeads: leads });

/**
 * A source handler ended its source. The source moves from pending to its outcome in one change, so it is never
 * counted two times or lost. The leads that the handler did not push are failed leads.
 */
export const sourceEnded = (outcome: Outcome, leadsNotPushed = 0): RequestProgress =>
  moving({ sourcesPending: -1, [sourceCounterOf[outcome]]: 1, leadsFailed: leadsNotPushed });

/** A lead handler took the leads of one request in its batch. */
export const leadBatchStarted = (leads: number): RequestProgress => ({ leadsPending: leads });

/** A lead handler ended the leads of one request in its batch. The leads move from pending to their outcomes. */
export const leadBatchEnded = (outcomes: { readonly processed: number; readonly failed: number }): RequestProgress =>
  moving({
    leadsPending: -(outcomes.processed + outcomes.failed),
    leadsProcessed: outcomes.processed,
    leadsFailed: outcomes.failed,
  });

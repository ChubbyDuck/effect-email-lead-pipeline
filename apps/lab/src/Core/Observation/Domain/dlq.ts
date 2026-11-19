import type { StageName } from '@leads/shared/domain/stages';

/**
 * The messages of the DLQ of one stage. A handler failed each of them, and SQS moved it to the DLQ. The lab shows
 * them as JSON, so that a person can see the failed input without the AWS console.
 */
import type { HandlerRun } from './runs';
import type { Json } from './snapshot';

/** The most messages that the source reads from one DLQ. */
export const dlqMessageLimit = 30;

/** One message of a DLQ. The body is JSON when it parses as JSON, and the text of the body when it does not. */
export interface DlqMessage {
  readonly messageId: string;
  readonly attributes: { readonly [key: string]: string };
  readonly messageAttributes?: { readonly [key: string]: Json };
  readonly body: Json;
}

/** A message of a DLQ, with what links it to the run that failed it. */
export interface DlqEntry {
  readonly message: DlqMessage;
  /** The S3 objects of an inbox or lead-sources message, with the keys as the handler reads them. */
  readonly objects: readonly StoredFile[];
  /** The requests of the message, from its body. A body that the source cannot read has none. */
  readonly requestIDs: readonly string[];
  /** When the trigger of the stage received the message. Each queue allows 1 receive, so 1 run took it. */
  readonly receivedAt?: string;
}

export interface StoredFile {
  readonly bucket: string;
  readonly key: string;
}

export interface DlqMessages {
  readonly deployment: string;
  readonly region: string;
  readonly stage: StageName;
  readonly queueName: string;
  readonly readAt: string;
  /** The messages that the DLQ has, as SQS counts them. It can be more than `messages`. */
  readonly approximateCount: number;
  /** Newest first. */
  readonly messages: readonly DlqEntry[];
}

export type DlqResult =
  | { readonly ok: true; readonly dlq: DlqMessages }
  | { readonly ok: false; readonly error: string };

/** The messages of each DLQ that name one request. A stage without a message is absent. */
export type DeadLetterCounts = Readonly<Partial<Record<StageName, number>>>;

/** The messages of the DLQs, by request ID. */
export type DeadLetters = Readonly<Record<string, DeadLetterCounts>>;

/**
 * Each message adds 1 to each request that it names. A read gives at most `dlqMessageLimit` messages, so a DLQ with
 * more messages can count too few.
 */
export function deadLettersOf(dlqs: readonly DlqMessages[]): DeadLetters {
  const counts: Record<string, Partial<Record<StageName, number>>> = {};
  for (const { stage, messages } of dlqs) {
    for (const { requestIDs } of messages) {
      for (const requestID of requestIDs) {
        const request = (counts[requestID] ??= {});
        request[stage] = (request[stage] ?? 0) + 1;
      }
    }
  }
  return counts;
}

/** A message that the redrive sent back to the main queue of its stage. */
export interface Redriven {
  readonly messageId: string;
  /** The ID of the new message in the main queue. SQS gives a sent message a new ID. */
  readonly sentMessageId: string;
  readonly queueName: string;
}

export type RedriveResult =
  | { readonly ok: true; readonly redriven: Redriven }
  | { readonly ok: false; readonly error: string };

/** What the search for the cause of a message knows about the message. */
export interface CauseQuery {
  readonly stage: StageName;
  readonly messageId: string;
  readonly receivedAt: Date;
  readonly requestIDs: readonly string[];
}

/** The query as the page sends it to the server. */
export interface CauseInput {
  readonly stage: StageName;
  readonly messageId: string;
  readonly receivedAt: string;
  readonly requestIDs: readonly string[];
}

/**
 * How the search found the run.
 * - `message`: a line of the run names the message. The handler logs it when the message goes to the DLQ.
 * - `request`: of the failed runs of the request, the run that started nearest to the receive.
 * - `time`: of all the failed runs, the run that started nearest to the receive. A run can fail before it logs its
 *   request, so a message with a request can also need this.
 */
export type CauseBasis =
  | { readonly kind: 'message' }
  | { readonly kind: 'request'; readonly requestID: string }
  | { readonly kind: 'time' };

export interface DlqCause {
  readonly messageId: string;
  readonly deployment: string;
  readonly region: string;
  readonly logGroup: string;
  /** The time that the search covered. */
  readonly from: string;
  readonly to: string;
  readonly found?: {
    readonly basis: CauseBasis;
    readonly run: HandlerRun;
    /** The runs that fit. Only `message` is certain; with more than 1, another run can be the cause. */
    readonly candidates: number;
  };
}

export type DlqCauseResult =
  | { readonly ok: true; readonly cause: DlqCause }
  | { readonly ok: false; readonly error: string };

/** In ms. Lambda starts a run after the trigger receives a message; with a cold start, some seconds after. */
const startBeforeReceiveMs = 2_000;
const startAfterReceiveMs = 30_000;

/** A run that ended without a failure released its messages, so it cannot be the cause. */
const failedRun = (run: HandlerRun) => run.outcome === 'failed' || run.outcome === 'timeout' || run.errors > 0;

/** The run that most likely took a message: of the failed runs that started near the receive, the nearest one. */
export function pickRun(
  runs: readonly HandlerRun[],
  receivedAt: number
): { readonly run: HandlerRun; readonly candidates: number } | undefined {
  const distance = (run: HandlerRun) => Date.parse(run.startedAt) - receivedAt;
  const fits = runs.filter(
    (run) => failedRun(run) && distance(run) >= -startBeforeReceiveMs && distance(run) <= startAfterReceiveMs
  );
  const [run] = fits.toSorted((a, b) => Math.abs(distance(a)) - Math.abs(distance(b)));
  return run === undefined ? undefined : { run, candidates: fits.length };
}

/** One message as SQS gives it. */
export interface RawDlqMessage {
  readonly MessageId?: string | undefined;
  readonly Body?: string | undefined;
  readonly Attributes?: { readonly [key: string]: string | undefined } | undefined;
  readonly MessageAttributes?:
    | {
        readonly [key: string]: {
          readonly DataType?: string | undefined;
          readonly StringValue?: string | undefined;
          readonly BinaryValue?: Uint8Array | undefined;
        };
      }
    | undefined;
}

export function bodyOf(body: string): Json {
  try {
    return JSON.parse(body) as Json;
  } catch {
    return body;
  }
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

export function toDlqMessage({ MessageId, Body, Attributes, MessageAttributes }: RawDlqMessage): DlqMessage {
  const attributes = Object.fromEntries(
    Object.entries(Attributes ?? {}).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const messageAttributes = Object.entries(MessageAttributes ?? {}).map(
    ([name, { DataType, StringValue, BinaryValue }]): [string, Json] => [
      name,
      {
        dataType: DataType ?? null,
        value: StringValue ?? (BinaryValue === undefined ? null : base64(BinaryValue)),
      },
    ]
  );
  return {
    messageId: MessageId ?? '',
    attributes,
    ...(messageAttributes.length > 0 && { messageAttributes: Object.fromEntries(messageAttributes) }),
    body: bodyOf(Body ?? ''),
  };
}

const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What a message is about, in one line. An S3 event gives the keys of its objects, as S3 encodes them in the event.
 * Another body gives its JSON.
 */
export function subjectOf({ body }: DlqMessage): string {
  const keys = s3KeysOf(body).map(({ key }) => key);
  if (keys.length > 0) return keys.join(', ');
  return typeof body === 'string' ? body : JSON.stringify(body);
}

/** The objects of an S3 event, with the keys as S3 encodes them in the event. Another body has none. */
export function s3KeysOf(body: Json): { readonly bucket: string; readonly key: string }[] {
  const records = isObject(body) && Array.isArray(body.Records) ? body.Records : [];
  return records.flatMap((record) => {
    const s3 = isObject(record) ? record.s3 : undefined;
    const bucket = isObject(s3) && isObject(s3.bucket) ? s3.bucket.name : undefined;
    const object = isObject(s3) ? s3.object : undefined;
    const key = isObject(object) ? object.key : undefined;
    return typeof bucket === 'string' && typeof key === 'string' ? [{ bucket, key }] : [];
  });
}

/** The request of a lead message, which names it in its body. */
export const leadRequestIDOf = (body: Json): string | undefined =>
  isObject(body) && typeof body.requestID === 'string' ? body.requestID : undefined;

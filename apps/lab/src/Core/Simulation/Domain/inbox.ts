import { emailBytes, megabyteBytes, workbookBytes } from './payloads';
import type { SliceInputs } from './sources';
import { outputSteps, spansOf, timeline, type Span, type Timeline } from './timeline';

/** Lambda memory of one inbox handler, in MB. The stack keeps the Lambda default. */
export const inboxMemory = 128;

/**
 * Inbox handlers and the sources they release. Source handlers take those sources. The times are the medians of the
 * last five requests of 1 Nov 2026, each with one source of 20 leads. The logs give ranges between lines, not one value
 * for each call, so `docs/simulator-layout.md` says how each range makes its knobs.
 */
export const inboxDefaults = {
  E: 50,
  S: 10,
  E_q_c: 50,
  in_c: 50,
  delay_in: 959,
  /**
   * RequestLedger.acknowledge: one conditional PutItem of a new request entry, before the handler reads the email.
   * No range of the logs shows it alone, so it takes the measured write of a lead handler, which has the same memory.
   */
  in_request_ledger_acknowledge_t: 99,
  in_storage_read_t: 889,
  in_email_parser_parse_t: 179,
  in_storage_store_t: 199,
  in_storage_delete_t: 21,
  /**
   * RequestLedger.record: one UpdateItem of the request entry. The handler records the attachment count and its end.
   * The measured write of a lead handler, as `in_request_ledger_acknowledge_t`.
   */
  in_request_ledger_record_t: 99,
  /**
   * ms one inbox handler spends on each MB it moves through S3, on top of the latency of the call.
   * Reads and puts move bytes; a delete does not. Puts at once share the network of the environment.
   * An estimate, about 50 MB/s: the files of the measured requests are too small to show it.
   */
  in_storage_mb_t: 20,
  /** INIT of a new inbox execution environment: Init Duration of the REPORT log line. One cold start was measured. */
  in_init_t: 567,
  /** Invocations an SQS event source mapping starts with. AWS documents five. */
  esm_start: 5,
  /** Invocations the mapping adds per minute while messages wait. AWS documents up to 300. */
  esm_rate: 300,
};
export type InboxInputs = typeof inboxDefaults;
export type InboxInputKey = keyof InboxInputs;
/** The inbox inputs, and the workbook size the inbox moves. */
export type InboxTimingInputs = InboxInputs & Pick<SliceInputs, 'L' | 'row_b'>;

/** Writes of the request entry by one inbox handler: the acknowledgement, the attachment count, and the end. */
export const inboxLedgerWrites = 3;

/** ms to move `bytes` through S3 at `msPerMb`, to the nearest ms, so every timing stays a whole ms as Lambda bills it. */
export const transferTime = (bytes: number, msPerMb: number) => Math.round((bytes / megabyteBytes) * msPerMb);

/** Storage.read of the raw email: the latency of the GET, then the email bytes. */
export function inboxReadTime(input: InboxTimingInputs) {
  return input.in_storage_read_t + transferTime(emailBytes(input), input.in_storage_mb_t);
}

/** One put wave of `sources` workbooks: the latency of one put, then the bytes of every put, which share the network. */
function inboxStoreWaveTime(input: InboxTimingInputs, sources: number) {
  return input.in_storage_store_t + transferTime(sources * workbookBytes(input), input.in_storage_mb_t);
}

const megabytes = (bytes: number) => `${Number((bytes / megabyteBytes).toFixed(2))} MB`;

/** The steps of one inbox handler: acknowledge, read, parse, count, the put waves, end, and delete. */
export function inboxTimeline(input: InboxTimingInputs): Timeline {
  return timeline('in_init_t', [
    {
      tone: 'ledger',
      symbol: 'in_request_ledger_acknowledge_t',
      call: 'RequestLedger.acknowledge',
      detail: 'Enter the request in the ledger as pending, so the email has a status before any later step can fail.',
      time: input.in_request_ledger_acknowledge_t,
    },
    {
      tone: 'get',
      symbol: 'in_storage_read_t',
      call: 'Storage.read',
      detail: `Read the email, ${megabytes(emailBytes(input))}.`,
      time: inboxReadTime(input),
    },
    {
      tone: 'parse',
      symbol: 'in_email_parser_parse_t',
      call: 'EmailParser.parse',
      detail: 'Read the sources off the email.',
      time: input.in_email_parser_parse_t,
    },
    {
      tone: 'ledger',
      symbol: 'in_request_ledger_record_t',
      call: 'RequestLedger.record',
      detail: `Record the ${input.S} ${input.S === 1 ? 'attachment' : 'attachments'} on the request entry, so the ledger knows how many sources to expect.`,
      time: input.in_request_ledger_record_t,
    },
    ...outputSteps({ units: input.S, perCall: 1, width: input.in_c, unit: 'source' }, (wave) => ({
      tone: 'put',
      symbol: 'in_storage_store_t',
      call: 'Storage.store',
      detail: `Release sources onto the sources bucket, ${megabytes(workbookBytes(input))} each, which then pushes an event into SQS Queue.`,
      waveTime: inboxStoreWaveTime(input, wave.amount),
    })),
    {
      tone: 'ledger',
      symbol: 'in_request_ledger_record_t',
      call: 'RequestLedger.record',
      detail: 'Record the end of the email as processed. The later delete does not change it.',
      time: input.in_request_ledger_record_t,
    },
    {
      tone: 'delete',
      symbol: 'in_storage_delete_t',
      call: 'Storage.delete',
      detail: 'Delete the email from the inbox. The pipeline keeps no copy of it.',
      time: input.in_storage_delete_t,
    },
  ]);
}

/** Ranges of one inbox handler, with `init` ms of INIT first. */
export function inboxSpans(input: InboxTimingInputs, init = 0): Span[] {
  return spansOf(inboxTimeline(input), { init });
}

export function inboxDuration(input: InboxTimingInputs) {
  return inboxTimeline(input).duration;
}

export function normalizeInboxInputs<T extends InboxInputs>(input: T): T {
  const next = { ...input };
  for (const key of Object.keys(inboxDefaults) as InboxInputKey[]) {
    const value = Number.isFinite(input[key]) ? input[key] : inboxDefaults[key];
    const time = key.endsWith('_t') || key.startsWith('delay_');
    next[key] = time ? Math.max(0, value) : Math.max(key === 'S' || key === 'esm_rate' ? 0 : 1, Math.floor(value));
  }
  return next;
}

export function inboxPutWaves(input: InboxInputs) {
  return input.S === 0 ? 0 : Math.ceil(input.S / input.in_c);
}

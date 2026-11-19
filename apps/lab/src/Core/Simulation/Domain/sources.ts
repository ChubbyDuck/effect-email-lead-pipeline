import { inboxDefaults, transferTime, type InboxInputs } from './inbox';
import { leadBatchLimits, leadDefaults, type LeadInputs } from './leads';
import { monthDefaults, type MonthInputs } from './month';
import { megabyteBytes, workbookBytes } from './payloads';
import { outputSteps, spansOf, timeline, type Span, type StepSpec, type Timeline } from './timeline';

/** Source handlers that take the sources an inbox handler releases. */
export const sourceDefaults = {
  L: 10_000,
  /** Queued `{ lead, requestID }`, rounded up from 770: the mean of the six workbook test leads. */
  lead_b: 800,
  /** Lambda memory of one source handler, in MB. A workbook of 100,000 rows peaks at about 1,000 MiB. */
  src_M: 1536,
  S_q_c: 50,
  /**
   * RequestLedger.record: one UpdateItem of the request entry. The handler records its start, the leads it found, and
   * its end. An estimate: no range of the logs shows it alone, and its memory differs from the lead handler. The range of
   * one write and one send has a median of 30 ms, so a write takes less than that.
   */
  src_request_ledger_record_t: 20,
  src_c: 200,
  delay_src: 900,
  /** Includes the work before the first log line of the handler, as the first range of the other handlers does. */
  src_storage_read_t: 104,
  src_excel_sheet_parser_parse_t: 7,
  src_queue_push_t: 10,
  src_storage_delete_t: 26,
  /**
   * ms one source handler spends on each MB of the workbook it reads, on top of the latency of the call.
   * An estimate, about 50 MB/s: the files of the measured requests are too small to show it.
   */
  src_storage_mb_t: 20,
  /** INIT of a new source execution environment: Init Duration of the REPORT log line. One cold start was measured. */
  src_init_t: 469,
  /** Bytes of one workbook row, rounded up from 248: the mean of the three 100,000-row bench workbooks. */
  row_b: 300,
};
export type SourceInputs = typeof sourceDefaults;

/** Lambda memory limits, in MB. */
export const lambdaMemory = { min: 128, max: 10_240 };

/** Leads in one `Queue.pushBatch` call. Matches `QueueBatchSize`, the SQS limit of ten entries per batch. */
export const leadBatchSize = 10;
export type SliceInputs = InboxInputs & SourceInputs & LeadInputs & MonthInputs;
export type SliceInputKey = keyof SliceInputs;
export const sliceDefaults: SliceInputs = { ...inboxDefaults, ...sourceDefaults, ...leadDefaults, ...monthDefaults };

const megabytes = (bytes: number) => `${Number((bytes / megabyteBytes).toFixed(2))} MB`;

/** Send waves drawn as their own ranges. More than this become one send stretch. */
const sendDrawLimit = 8;

export function normalizeSliceInputs(input: SliceInputs): SliceInputs {
  const next = { ...sliceDefaults, ...input };
  for (const key of Object.keys(sliceDefaults) as SliceInputKey[]) {
    const value = Number.isFinite(input[key]) ? input[key] : sliceDefaults[key];
    const time = key.endsWith('_t') || key.startsWith('delay_');
    const optional = key === 'S' || key === 'L' || key === 'lead_b' || key === 'row_b' || key === 'esm_rate';
    next[key] = time ? Math.max(0, value) : Math.max(optional ? 0 : 1, Math.floor(value));
    if (key === 'src_M' || key === 'ld_M')
      next[key] = Math.min(lambdaMemory.max, Math.max(lambdaMemory.min, next[key]));
    if (key === 'ld_batch') next[key] = Math.min(leadBatchLimits.maxBatch, next[key]);
    if (key === 'ld_window_t') next[key] = Math.min(leadBatchLimits.maxWindow, next[key]);
  }
  return next;
}

/**
 * Writes of the request entry by one source handler: its start, the leads it found, and its end. A source with no
 * leads is rejected before it records any leads.
 */
export function sourceLedgerWrites(input: Pick<SliceInputs, 'L'>) {
  return input.L > 0 ? 3 : 2;
}

/** Batches one source handler pushes: its leads in groups of `leadBatchSize`. */
export function sourceBatches(input: SliceInputs) {
  return Math.ceil(input.L / leadBatchSize);
}

/** Send waves inside one source handler. A wave pushes up to `src_c` batches at once. */
export function sourceSendWaves(input: SliceInputs) {
  const batches = sourceBatches(input);
  return batches === 0 ? 0 : Math.ceil(batches / input.src_c);
}

/** Storage.read of the workbook: the latency of the GET, then the workbook bytes. */
export function sourceReadTime(input: SliceInputs) {
  return input.src_storage_read_t + transferTime(workbookBytes(input), input.src_storage_mb_t);
}

/** The steps of one source handler: start, read, parse, the leads found, the send waves, end, and delete. */
export function sourceTimeline(input: SliceInputs): Timeline {
  const record = (detail: string): StepSpec => ({
    tone: 'ledger',
    symbol: 'src_request_ledger_record_t',
    call: 'RequestLedger.record',
    detail,
    time: input.src_request_ledger_record_t,
  });
  return timeline('src_init_t', [
    record('Record the start of the source on the request entry: one more source pending.'),
    {
      tone: 'get',
      symbol: 'src_storage_read_t',
      call: 'Storage.read',
      detail: `Read the source, ${megabytes(workbookBytes(input))}.`,
      time: sourceReadTime(input),
    },
    {
      tone: 'parse',
      symbol: 'src_excel_sheet_parser_parse_t',
      call: 'ExcelSheetParser.parse',
      detail: 'Read the leads off the source.',
      time: input.src_excel_sheet_parser_parse_t,
    },
    ...(input.L > 0
      ? [
          record(
            `Record the ${input.L.toLocaleString('en-US')} leads the source found, before the first send, so a lead handler never ends a lead the request does not count.`
          ),
        ]
      : []),
    ...outputSteps({ units: input.L, perCall: leadBatchSize, width: input.src_c, unit: 'lead' }, (wave) => ({
      tone: 'send',
      symbol: 'src_queue_push_t',
      call: 'Queue.pushBatch',
      detail: `Push ${wave.calls} ${wave.calls === 1 ? 'batch' : 'batches'} of up to ${leadBatchSize} leads onto the leads queue.`,
      waveTime: input.src_queue_push_t,
    })),
    record(
      input.L > 0
        ? 'Record the end of the source as processed. The later delete does not change it.'
        : 'Record the end of the source as rejected: it has no valid leads.'
    ),
    {
      tone: 'delete',
      symbol: 'src_storage_delete_t',
      call: 'Storage.delete',
      detail: 'Delete the source, processed or rejected. The pipeline keeps no copy of it.',
      time: input.src_storage_delete_t,
    },
  ]);
}

export function sourceDuration(input: SliceInputs) {
  return sourceTimeline(input).duration;
}

/** Ranges of one source handler, with `init` ms of INIT first. Many send waves are one range. */
export function sourceSpans(input: SliceInputs, init = 0): Span[] {
  const waves = sourceSendWaves(input);
  return spansOf(sourceTimeline(input), {
    init,
    ...(waves > sendDrawLimit && {
      stretch: `${waves} send waves, each pushing up to ${input.src_c} ${input.src_c === 1 ? 'batch' : 'batches'} of ${leadBatchSize} leads, taking ${input.src_queue_push_t} ms.`,
    }),
  });
}

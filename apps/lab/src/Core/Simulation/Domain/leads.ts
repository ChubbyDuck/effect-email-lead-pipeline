import { orderWritesPerSecond } from '@leads/shared/domain/orderWrites';

import { outputSteps, spansOf, timeline, type Span, type StepSpec, type Timeline } from './timeline';

/** Lead handlers that take the leads source handlers push onto the leads queue. */
export const leadDefaults = {
  L_q_c: 200,
  /** Leads the event source mapping hands one lead handler. */
  ld_batch: 10,
  /** How long the mapping holds a partial batch before it invokes a handler with it. */
  ld_window_t: 10_000,
  ld_c: 10,
  /** Orders one lead execution environment writes in a second. Each store takes one token from its bucket. */
  ld_writes: orderWritesPerSecond.environment,
  /**
   * Requests whose leads one lead handler takes. A standard queue mixes the leads of the sources that push at once, so
   * one batch can hold the leads of many requests. The handler writes one start and one end for each of them.
   */
  ld_requests: 1,
  /** Lambda memory of one lead handler, in MB. The stack keeps the Lambda default. */
  ld_M: 128,
  delay_ld: 52,
  ld_records_parse_t: 78,
  /** One wave of conditional PutItems into the orders table, on the CPU share of a 128 MB handler. */
  ld_order_repository_store_t: 399,
  /** RequestLedger.record: one UpdateItem of the request entry. The time after the last log line of a run shows it alone. */
  ld_request_ledger_record_t: 99,
  /** INIT of a new lead execution environment: Init Duration of the REPORT log line. Two cold starts were measured. */
  ld_init_t: 581,
};
export type LeadInputs = typeof leadDefaults;

/** SQS event source mapping limits for a standard queue. */
export const leadBatchLimits = { maxBatch: 10_000, maxWindow: 300_000 };

/** Lambda takes at most 6 MB of payload in one invocation. The mapping invokes early with a smaller batch. */
export const invokePayloadBytes = 6 * 1024 * 1024;

/** Store waves drawn as their own ranges. More than this become one store stretch. */
const storeDrawLimit = 8;

/** A full bucket holds the tokens of this many ms, so a rest longer than this adds no token. */
const bucketTime = 1000;

/** Leads one full batch holds: `ld_batch`, cut down so the batch fits one invocation payload. The record envelope is left out. */
export function leadsPerHandler(input: LeadInputs & { lead_b: number }) {
  if (input.lead_b === 0) return input.ld_batch;
  return Math.max(1, Math.min(input.ld_batch, Math.floor(invokePayloadBytes / input.lead_b)));
}

/** Store waves inside one lead handler of `leads` leads. A wave stores up to `ld_c` leads at once. */
export function leadStoreWaves(input: LeadInputs, leads: number) {
  return leads === 0 ? 0 : Math.ceil(leads / input.ld_c);
}

/** Requests whose leads one lead handler of `leads` leads takes. Each lead belongs to one request. */
export function leadRequests(input: LeadInputs, leads: number) {
  return Math.min(input.ld_requests, leads);
}

/** Writes of request entries by one lead handler of `leads` leads: one start and one end for each request. */
export function leadLedgerWrites(input: LeadInputs, leads: number) {
  return 2 * leadRequests(input, leads);
}

/** Ledger waves for one side, start or end, of one lead handler. A wave writes up to `ld_c` entries at once. */
export function leadLedgerWaves(input: LeadInputs, leads: number) {
  const requests = leadRequests(input, leads);
  return requests === 0 ? 0 : Math.ceil(requests / input.ld_c);
}

/**
 * The steps of one lead handler of `leads` leads: the parse, the starts, the store waves, and the ends. The handler
 * waits `wait` ms for its tokens before the stores, and `leadTokenWait` gives that time.
 */
export function leadTimeline(input: LeadInputs, leads: number, wait = 0): Timeline {
  const requests = leadRequests(input, leads);
  const ledgerWaves = leadLedgerWaves(input, leads);
  const ofRequests = `${requests} ${requests === 1 ? 'request' : 'requests'}`;
  const inWaves = ledgerWaves > 1 ? `, in ${ledgerWaves} waves of up to ${input.ld_c}` : '';
  const record = (detail: string): StepSpec => ({
    tone: 'ledger',
    symbol: 'ld_request_ledger_record_t',
    call: 'RequestLedger.record',
    detail,
    time: ledgerWaves * input.ld_request_ledger_record_t,
  });
  const tokens = (): StepSpec => ({
    tone: 'wait',
    symbol: 'ld_writes',
    name: 'Wait for tokens',
    call: 'RateLimiter.consume',
    detail: `Wait for the tokens of the order write limit: ${input.ld_writes.toLocaleString('en-US')} writes a second for each execution environment. Lambda bills this wait.`,
    time: wait,
  });
  return timeline('ld_init_t', [
    {
      tone: 'parse',
      symbol: 'ld_records_parse_t',
      name: 'Parse records',
      call: 'toLeadsAndRejectionsFromRecords',
      detail: 'Read the leads off the SQS records.',
      time: input.ld_records_parse_t,
    },
    record(`Record the start of the leads of ${ofRequests}, one write each${inWaves}.`),
    ...(wait > 0 ? [tokens()] : []),
    ...outputSteps({ units: leads, perCall: 1, width: input.ld_c, unit: 'lead' }, (wave) => ({
      tone: 'store',
      symbol: 'ld_order_repository_store_t',
      call: 'OrderRepository.store',
      detail: `Store ${wave.amount} ${wave.amount === 1 ? 'lead' : 'leads'} as orders, one call each.`,
      waveTime: input.ld_order_repository_store_t,
    })),
    record(`Record the end of the leads of ${ofRequests}: processed or failed, one write each${inWaves}.`),
  ]);
}

export function leadDuration(input: LeadInputs, leads: number, wait = 0) {
  return leadTimeline(input, leads, wait).duration;
}

/**
 * ms one handler of `leads` leads waits for the tokens of the order write limit, on top of `work`, the time of its
 * steps. Each store takes one token. A handler ends with an empty bucket, so its next batch gets its tokens from the
 * `rest` of the environment and from `work`. A new environment has a full bucket, so its `rest` is infinite.
 */
export function leadTokenWait(input: LeadInputs, leads: number, rest = 0, work = leadDuration(input, leads)) {
  return Math.max(0, (leads * bucketTime) / input.ld_writes - Math.min(bucketTime, rest) - work);
}

/**
 * Ranges of one lead handler of `leads` leads, with `init` ms of INIT first, and `wait` ms for its tokens. Many store
 * waves are one range.
 */
export function leadSpans(input: LeadInputs, leads: number, init = 0, wait = 0): Span[] {
  const waves = leadStoreWaves(input, leads);
  return spansOf(leadTimeline(input, leads, wait), {
    init,
    ...(waves > storeDrawLimit && {
      stretch: `${waves} store waves, each storing up to ${input.ld_c} ${input.ld_c === 1 ? 'lead' : 'leads'}, taking ${input.ld_order_repository_store_t} ms.`,
    }),
  });
}

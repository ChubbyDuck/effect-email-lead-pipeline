import { handlerTimeouts } from '@leads/shared/domain/handlerTimeouts';
import { orderWritesPerSecond } from '@leads/shared/domain/orderWrites';

import { inboxDuration } from './inbox';
import { leadsPerHandler, leadTimeline, leadTokenWait } from './leads';
import { base64Bytes, emailBytes, emailHeaderBytes } from './payloads';
import { sqsBatchLimitBytes } from './sourceCharges';
import { leadBatchSize, sourceDuration, type SliceInputKey, type SliceInputs } from './sources';
import { timeOf } from './timeline';

/** SES does not store a received email larger than 40 MB in S3. */
export const sesMaxBytes = 40 * 1024 * 1024;

/** A combination of inputs the deployed app cannot run. */
export interface Limit {
  /** The knobs that cause it. */
  keys: SliceInputKey[];
  title: string;
  detail: string;
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const count = (value: number) => Math.max(0, value).toLocaleString('en-US');
const seconds = (ms: number) => `${(ms / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} s`;

/** The largest whole number in [0, high] that `fits`, when `fits` holds for every number below one it holds for. -1 when 0 does not fit. */
function largestFitting(high: number, fits: (value: number) => boolean) {
  if (!fits(0)) return -1;
  let low = 0;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The most rows one workbook can have when S workbooks share one email under the SES limit. */
export function maxRowsPerSource(input: SliceInputs) {
  if (input.S === 0 || input.row_b === 0) return Number.POSITIVE_INFINITY;
  const room = (sesMaxBytes - emailHeaderBytes) / input.S;
  let low = 0;
  let high = Math.ceil(room / input.row_b);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (base64Bytes(middle * input.row_b) <= room) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The most workbooks of L rows one email can carry under the SES limit. */
export function maxSourcesPerEmail(input: SliceInputs) {
  const one = base64Bytes(input.L * input.row_b);
  if (one === 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((sesMaxBytes - emailHeaderBytes) / one));
}

/** Every rule the inputs break. An empty list means the deployed app can run this combination. */
export function sliceLimits(input: SliceInputs): Limit[] {
  const limits: Limit[] = [];

  const bytes = emailBytes(input);
  if (bytes > sesMaxBytes) {
    limits.push({
      keys: ['S', 'L', 'row_b'],
      title: `One email is ${mb(bytes)}. SES bounces an email over 40 MB.`,
      detail: `The sender gets a bounce and the pipeline never starts. With S = ${count(input.S)}, L can be at most ${count(maxRowsPerSource(input))}. With L = ${count(input.L)}, S can be at most ${count(maxSourcesPerEmail(input))}.`,
    });
  }

  const inbox = input.in_init_t + inboxDuration(input);
  if (inbox > handlerTimeouts.inbox) {
    // More sources add put waves and make the email larger, so the read takes longer too.
    const sources = largestFitting(
      input.S,
      (S) => input.in_init_t + inboxDuration({ ...input, S }) <= handlerTimeouts.inbox
    );
    limits.push({
      keys: ['S', 'in_c', 'in_storage_mb_t'],
      title: `A cold inbox handler runs ${seconds(inbox)}. Its timeout is ${seconds(handlerTimeouts.inbox)}.`,
      detail: `Lambda stops the handler, and the email goes to the dead-letter queue after one try.${
        sources > 0
          ? ` With in_c = ${count(input.in_c)}, S can be at most ${count(sources)}.`
          : ' Shorten the inbox timings.'
      }`,
    });
  }

  const source = input.src_init_t + sourceDuration(input);
  if (input.S > 0 && source > handlerTimeouts.source) {
    // More leads add send waves and make the workbook larger, so the read takes longer too.
    const rows = largestFitting(
      input.L,
      (L) => input.src_init_t + sourceDuration({ ...input, L }) <= handlerTimeouts.source
    );
    limits.push({
      keys: ['L', 'src_c', 'src_storage_mb_t'],
      title: `A cold source handler runs ${seconds(source)}. Its timeout is ${seconds(handlerTimeouts.source)}.`,
      detail: `Lambda stops the handler after it pushed only part of the leads, and the source goes to the dead-letter queue after one try.${
        rows > 0
          ? ` With src_c = ${count(input.src_c)}, L can be at most ${count(rows)}.`
          : ' Shorten the source timings.'
      }`,
    });
  }

  const leadsInBatch = leadsPerHandler(input);
  const leadSteps = leadTimeline(input, leadsInBatch);
  const lead = input.ld_init_t + leadSteps.duration;
  if (input.E * input.S * input.L > 0 && lead > handlerTimeouts.lead) {
    // Every step but the stores stays as it is, so the stores get the rest of the timeout.
    const rest = leadSteps.duration - timeOf(leadSteps, 'store');
    const storeWaves =
      input.ld_order_repository_store_t === 0
        ? 0
        : Math.floor((handlerTimeouts.lead - input.ld_init_t - rest) / input.ld_order_repository_store_t);
    limits.push({
      keys: ['ld_batch', 'ld_c'],
      title: `A cold lead handler runs ${seconds(lead)}. Its timeout is ${seconds(handlerTimeouts.lead)}.`,
      detail: `Lambda stops the handler before it stored the whole batch, and the unstored leads go to the dead-letter queue after one try.${
        storeWaves > 0
          ? ` With ld_c = ${count(input.ld_c)}, ld_batch can be at most ${count(storeWaves * input.ld_c)}.`
          : ' Shorten the lead timings.'
      }`,
    });
  }

  // A handler that follows the previous batch finds an empty bucket, however fast its steps are.
  const tokenWait = leadTokenWait(input, leadsInBatch);
  const tokenRun = leadSteps.duration + tokenWait;
  if (input.E * input.S * input.L > 0 && tokenWait > 0 && tokenRun > handlerTimeouts.lead) {
    limits.push({
      keys: ['ld_batch', 'ld_writes'],
      title: `A lead handler waits for its tokens and runs ${seconds(tokenRun)}. Its timeout is ${seconds(handlerTimeouts.lead)}.`,
      detail: `Lambda stops the handler before it stored the whole batch, and the unstored leads go to the dead-letter queue after one try. With ld_writes = ${count(input.ld_writes)}, ld_batch can be at most ${count(Math.floor((handlerTimeouts.lead * input.ld_writes) / 1000))}.`,
    });
  }

  const orderWrites = input.L_q_c * input.ld_writes;
  if (orderWrites > orderWritesPerSecond.stack) {
    limits.push({
      keys: ['L_q_c', 'ld_writes'],
      title: `The lead handlers can write ${count(orderWrites)} orders a second. The order write limit is ${count(orderWritesPerSecond.stack)}.`,
      detail: `A test of the stack stops this deploy. With ld_writes = ${count(input.ld_writes)}, L_q_c can be at most ${count(Math.floor(orderWritesPerSecond.stack / input.ld_writes))}. With L_q_c = ${count(input.L_q_c)}, ld_writes can be at most ${count(Math.floor(orderWritesPerSecond.stack / input.L_q_c))}.`,
    });
  }

  const batch = Math.min(input.L, leadBatchSize) * input.lead_b;
  if (input.S > 0 && batch > sqsBatchLimitBytes) {
    limits.push({
      keys: ['lead_b'],
      title: `One batch of leads is ${mb(batch)}. SQS rejects a batch over 1 MiB.`,
      detail: `Every lead in that batch fails. lead_b can be at most ${count(Math.floor(sqsBatchLimitBytes / Math.min(input.L, leadBatchSize)))} bytes.`,
    });
  }

  return limits;
}

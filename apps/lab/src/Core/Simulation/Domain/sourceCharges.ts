import {
  addSplits,
  billedSeconds,
  gigabytesOf,
  memoryGb,
  scaleSplit,
  type ServiceSplit,
} from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';

import {
  amount,
  coldStartLine,
  consumptionWarning,
  dollars,
  figure,
  ledgerDetail,
  ledgerPrice,
  logDetail,
  price,
  slotDetail,
  type ChargeLine,
  type Charges,
} from './charges';
import { logCost, sourceLogBytes } from './logs';
import { inMegabytes, workbookBytes } from './payloads';
import { scheduleSlice, type SliceSchedule } from './schedule';
import { leadBatchSize, sourceBatches, sourceDuration, sourceLedgerWrites, type SliceInputs } from './sources';

/** SQS bills each 64 KB of one API payload as one request. A call is never free. */
export const sqsChunkBytes = 64 * 1024;

/** SQS rejects a batch whose payload is larger than 1 MiB. */
export const sqsBatchLimitBytes = 1024 * 1024;

/** Requests SQS bills for one API call that carries `bytes` of payload. */
export function payloadRequests(bytes: number) {
  return Math.max(1, Math.ceil(Math.max(0, bytes) / sqsChunkBytes));
}

/** One source handler's `Queue.pushBatch` calls: full batches of `leadBatchSize`, then the remainder. */
export function leadBatchSends(leads: number, bytes: number) {
  const full = Math.floor(leads / leadBatchSize);
  const remainder = leads - full * leadBatchSize;
  const fullRequests = payloadRequests(leadBatchSize * bytes);
  const remainderRequests = remainder > 0 ? payloadRequests(remainder * bytes) : 0;
  return { full, remainder, fullRequests, remainderRequests, requests: full * fullRequests + remainderRequests };
}

/**
 * Source time is the source-handler clock: from the first source the inbox releases to the end of the last source bar.
 * Pure price is one source on a warm environment. Applied price is every source, plus INIT of every new environment.
 * A lead message is `lead_b` bytes. Leads go out in batches of `leadBatchSize`.
 * Each 64 KB of one batch payload is one request at $0.40 per million.
 */
export function sourceCharges(
  input: SliceInputs,
  schedule: Pick<SliceSchedule, 'releases' | 'sources'> = scheduleSlice(input)
): Charges {
  const sources = input.E * input.S;
  const duration = sourceDuration(input);
  const delay = sources === 0 ? 0 : input.delay_src;
  const run = schedule.sources;
  const firstRelease = schedule.releases[0]?.at ?? 0;
  const end = sources === 0 ? 0 : run.end;
  const clock = Math.max(0, end - firstRelease);
  const handlerTime = Math.max(0, clock - delay);
  const cold = coldStartLine(run, input.src_init_t, input.src_M, 'src_init_t', 'src_M', 'source');
  const seconds = billedSeconds(duration);
  const gigabytes = memoryGb(input.src_M);
  const request = prices.sqsRequest;
  const invocation = prices.lambdaRequest;
  const compute = seconds * gigabytes * prices.lambdaGbSecond;
  const read = prices.s3Get;
  const batches = sourceBatches(input);
  const batchSends = leadBatchSends(input.L, input.lead_b);
  const sends = batchSends.requests * request;
  const batchBytes = Math.min(input.L, leadBatchSize) * input.lead_b;
  const logBytes = sourceLogBytes(input);
  const logs = logCost(logBytes);
  const handler = invocation + compute + read + sends + logs;
  const handlerSplit: ServiceSplit = { Lambda: invocation + compute, S3: read, SQS: sends, 'CloudWatch Logs': logs };
  const consumption = 3 * request;
  const consumptionSplit: ServiceSplit = { SQS: consumption };
  const ledgerWrites = sourceLedgerWrites(input);
  const ledger = ledgerPrice(ledgerWrites, 'ledger writes');
  const oneSource = consumption + handler + ledger.value;
  const oneSourceSplit = addSplits(consumptionSplit, handlerSplit, ledger.services);
  const sendClock = input.L === 0 ? '0' : `ceil(ceil(${input.L} / ${leadBatchSize}) / ${input.src_c})`;
  const workbookMb = `${inMegabytes(workbookBytes(input))} MB × ${input.src_storage_mb_t}`;
  const record = input.src_request_ledger_record_t;
  const foundClock = input.L > 0 ? `${record} + ` : '';
  const durationSubstitution = `${record} + ${input.src_storage_read_t} + ${workbookMb} + ${input.src_excel_sheet_parser_parse_t} + ${foundClock}${sendClock} × ${input.src_queue_push_t} + ${record} + ${input.src_storage_delete_t} ms`;
  const counted = `${sources} sources`;
  const sendTerms = [
    ...(batchSends.full > 0
      ? [`${batchSends.full} × ceil(${leadBatchSize} × ${input.lead_b} / ${sqsChunkBytes}) × ${dollars(request)}`]
      : []),
    ...(batchSends.remainder > 0
      ? [`1 × ceil(${batchSends.remainder} × ${input.lead_b} / ${sqsChunkBytes}) × ${dollars(request)}`]
      : []),
  ];
  const sendTerm = sendTerms.length === 0 ? `0 × ${dollars(request)}` : sendTerms.join('\n+ ');
  const handlerWarnings = [
    ...(batchBytes > sqsBatchLimitBytes
      ? [
          `A batch of ${Math.min(input.L, leadBatchSize)} leads is ${batchBytes.toLocaleString('en-US')} bytes. SQS rejects a batch over ${sqsBatchLimitBytes.toLocaleString('en-US')} bytes, so every lead in it fails.`,
        ]
      : []),
    ...(batchSends.fullRequests > 1 || batchSends.remainderRequests > 1
      ? [
          `A batch of ${Math.min(input.L, leadBatchSize)} leads at ${input.lead_b.toLocaleString('en-US')} bytes each is ${payloadRequests(batchBytes)} SQS requests. SQS bills each 64 KB of one payload as one request, and one batch is one API call, so the chunks add up on that call.`,
        ]
      : []),
  ];
  const handlerTerms = [
    `1 × ${dollars(invocation)}`,
    `${amount(seconds)} s × ${amount(gigabytes)} GB × ${dollars(prices.lambdaGbSecond)}`,
    `1 × ${dollars(read)}`,
    sendTerm,
    `${amount(gigabytesOf(logBytes))} GB × (${dollars(prices.logIngestGb)} + ${dollars(prices.logStorageGbMonth)})`,
  ].join('\n+ ');
  const lines: ChargeLine[] = [
    {
      label: 'Source consumption',
      ...(sources > 0 ? { warning: consumptionWarning(sources, request, 'source', 'sources') } : {}),
      detail:
        'S3 sends one notification per source, about 800 bytes, when the inbox stores the file. Each source handler receives that message and deletes it. All three are one SQS request, because 64 KB is the request size at $0.40 per million. The send is not a bar; the time is the start delay.',
      time: figure(delay, '0 + delay_src', `0 + ${delay} ms`),
      pure: price(
        consumption,
        '1 send + 1 receive + 1 delete, each $0.40 / 1,000,000',
        `${dollars(request)} + ${dollars(request)} + ${dollars(request)}`,
        consumptionSplit
      ),
      applied: price(
        sources * consumption,
        'E × S sends + E × S receives + E × S deletes',
        `${counted} × ${dollars(request)} + ${counted} × ${dollars(request)} + ${counted} × ${dollars(request)}`,
        scaleSplit(consumptionSplit, sources)
      ),
    },
    {
      label: 'Handlers',
      ...(handlerWarnings.length > 0 ? { warning: handlerWarnings.join(' ') } : {}),
      detail: `Each source is one Lambda invocation, its compute, one S3 read, and one SQS batch send per ${leadBatchSize} leads. S3 bills a request at one price for any size, but the handler waits for the bytes: src_storage_mb_t ms per MB of the ${inMegabytes(workbookBytes(input))} MB workbook, on top of the latency of the read. ${input.L.toLocaleString('en-US')} leads are ${batches.toLocaleString('en-US')} ${batches === 1 ? 'batch' : 'batches'}. SQS bills each 64 KB of one batch payload as one request. The handler then deletes the source, processed or rejected, and S3 delete is free. Each handler logs ${logBytes.toLocaleString('en-US')} bytes: START, END, and REPORT, the size of the source, and one progress line for each ledger write. ${logDetail} ${slotDetail('S_q_c')} Running together does not reduce the bill.`,
      time: figure(
        handlerTime,
        'last source bar end − first source arrival',
        `T = ${durationSubstitution}; ${end} − (${firstRelease} + ${delay}) ms`
      ),
      pure: price(
        handler,
        `1 invocation + (ceil(T) / 1000) s × (src_M / 1024) GB × GB-second + 1 read + floor(L / ${leadBatchSize}) × ceil(${leadBatchSize} × lead_b / 65536) + ceil((L mod ${leadBatchSize}) × lead_b / 65536) batch sends + log bytes / 2^30 × (log GB taken in + log GB kept one month)`,
        handlerTerms,
        handlerSplit
      ),
      applied: price(
        sources * handler,
        'E × S sources × one handler',
        `${counted} × ${dollars(handler)}`,
        scaleSplit(handlerSplit, sources)
      ),
    },
    {
      label: 'Ledger writes',
      detail: `RequestLedger.record updates the request entry of the email that gave the source: one more source pending before the read, the leads it found before the first send, and its end after the last send. A source with no leads is rejected after the parse, so it records no leads. ${ledgerDetail}`,
      time: figure(
        sources === 0 ? 0 : ledgerWrites * record,
        input.L > 0 ? '3 × src_request_ledger_record_t' : '2 × src_request_ledger_record_t, when L = 0',
        `${ledgerWrites} × ${record} ms`
      ),
      pure: ledger,
      applied: price(
        sources * ledger.value,
        'E × S sources × one source of ledger writes',
        `${counted} × ${dollars(ledger.value)}`,
        scaleSplit(ledger.services, sources)
      ),
    },
    cold,
  ];
  return {
    lines,
    time: figure(clock, 'last source bar end − first source release', `${delay} + ${handlerTime} ms`),
    pure: price(
      oneSource,
      'consumption + handler + ledger',
      `${dollars(consumption)} + ${dollars(handler)} + ${dollars(ledger.value)}`,
      oneSourceSplit
    ),
    applied: price(
      sources * oneSource + cold.applied.value,
      'E × S sources × (consumption + handler + ledger) + cold starts',
      `${counted} × (${dollars(consumption)} + ${dollars(handler)} + ${dollars(ledger.value)}) + ${dollars(cold.applied.value)}`,
      addSplits(scaleSplit(oneSourceSplit, sources), cold.applied.services)
    ),
  };
}

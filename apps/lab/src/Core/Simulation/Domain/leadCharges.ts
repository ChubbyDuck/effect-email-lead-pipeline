import { addSplits, billedSeconds, dynamoWriteUnitBytes, gigabytesOf, memoryGb } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';

import {
  amount,
  coldStartLine,
  dollars,
  figure,
  ledgerDetail,
  logDetail,
  perMillion,
  price,
  slotDetail,
  type ChargeLine,
  type Charges,
} from './charges';
import {
  invokePayloadBytes,
  leadDuration,
  leadLedgerWaves,
  leadLedgerWrites,
  leadRequests,
  leadsPerHandler,
  leadTimeline,
  leadTokenWait,
} from './leads';
import { leadLogBytes, logCost as logPrice } from './logs';
import { ledgerWriteCost, requestEntryWriteUnits } from './requestLedger';
import { scheduleSlice, type SliceSchedule } from './schedule';
import { payloadRequests, sqsChunkBytes } from './sourceCharges';
import type { SliceInputs } from './sources';
import { timeOf } from './timeline';

/** SQS returns at most ten messages per receive, and deletes at most ten per delete-batch. */
export const receiveLimit = 10;

/** SQS calls the event source mapping makes to hand one handler `leads` leads, then delete them after it succeeds. */
export function leadConsumption(leads: number, bytes: number) {
  const calls = Math.ceil(leads / receiveLimit);
  const full = Math.floor(leads / receiveLimit);
  const remainder = leads - full * receiveLimit;
  const receives =
    full * payloadRequests(receiveLimit * bytes) + (remainder > 0 ? payloadRequests(remainder * bytes) : 0);
  return { calls, receives, deletes: calls, requests: receives + calls };
}

/** Write request units of one order. The item is the lead without the queue envelope, so `lead_b` bytes is an upper bound. */
export function orderWriteUnits(bytes: number) {
  return Math.max(1, Math.ceil(bytes / dynamoWriteUnitBytes));
}

/**
 * Lead time is the lead-handler clock: from the first lead the source handlers push to the end of the last lead bar.
 * Pure price is one full batch on a warm environment that follows the previous batch, so it waits for all its tokens.
 * Applied price is every batch the mapping invokes, each with its own wait, plus INIT of every new environment.
 * The source handlers pay for the sends. The mapping pays for the receives and the deletes.
 * `OrderRepository.store` puts each lead into DynamoDB. The bill counts the write units. One month of storage is in the detail only.
 */
export function leadCharges(
  input: SliceInputs,
  schedule: Pick<SliceSchedule, 'leadReleases' | 'leads'> = scheduleSlice(input)
): Charges {
  const run = schedule.leads;
  const leads = input.E * input.S * input.L;
  const batch = leadsPerHandler(input);
  // Handlers of one batch size differ by their wait for tokens, so each size keeps the seconds of all its runs.
  const byBatch = new Map<number, { count: number; billed: number; work: number }>();
  for (const wave of run.waves) {
    const size = wave.batch ?? 1;
    const group = byBatch.get(size) ?? { count: 0, billed: 0, work: leadDuration(input, size) };
    group.count += wave.count;
    group.billed += wave.count * billedSeconds(group.work + (wave.wait ?? 0));
    byBatch.set(size, group);
  }
  const groups = [...byBatch].sort((a, b) => b[0] - a[0]);
  const request = prices.sqsRequest;
  const gigabytes = memoryGb(input.ld_M);
  const wait = leadTokenWait(input, batch);
  const steps = leadTimeline(input, batch, wait);
  const duration = steps.duration;
  const seconds = billedSeconds(duration);
  const lambdaOf = (billed: number) => prices.lambdaRequest + billed * gigabytes * prices.lambdaGbSecond;
  const lambdaCost = (size: number) => {
    const group = byBatch.get(size);
    return lambdaOf(group === undefined ? seconds : group.billed / group.count);
  };
  const logCost = (size: number) => logPrice(leadLogBytes(input, size));
  const handlerCost = (size: number) => lambdaCost(size) + logCost(size);
  const consumptionCost = (size: number) => leadConsumption(size, input.lead_b).requests * request;
  const every = (cost: (size: number) => number) =>
    groups.reduce((sum, [size, { count }]) => sum + count * cost(size), 0);
  const terms = (cost: (size: number) => number) =>
    groups.length === 0
      ? `0 × ${dollars(cost(batch))}`
      : groups
          .map(
            ([size, { count }]) => `${count} ${count === 1 ? 'batch' : 'batches'} of ${size} × ${dollars(cost(size))}`
          )
          .join('\n+ ');
  const units = orderWriteUnits(input.lead_b);
  const writeCost = (size: number) => size * units * prices.dynamoWriteUnit;
  const ledgerCost = (size: number) => ledgerWriteCost(leadLedgerWrites(input, size));
  const consumption = consumptionCost(batch);
  const pureLambda = lambdaOf(seconds);
  const handler = pureLambda + logCost(batch);
  const writes = writeCost(batch);
  const ledger = ledgerCost(batch);
  const oneBatch = consumption + handler + writes + ledger;
  const consumptionApplied = every(consumptionCost);
  const handlerApplied = every(handlerCost);
  const lambdaApplied = every(lambdaCost);
  const logsApplied = every(logCost);
  const logBytes = leadLogBytes(input, batch);
  const writesApplied = every(writeCost);
  const ledgerApplied = every(ledgerCost);
  const requests = leadRequests(input, batch);
  const ledgerWaves = leadLedgerWaves(input, batch);
  const ledgerTime = timeOf(steps, 'ledger');
  const storedGigabytes = gigabytesOf(leads * input.lead_b);
  const storeTime = timeOf(steps, 'store');
  const one = leadConsumption(batch, input.lead_b);
  const delay = leads === 0 ? 0 : input.delay_ld;
  const firstRelease = schedule.leadReleases[0]?.at ?? 0;
  const end = leads === 0 ? 0 : run.end;
  const clock = Math.max(0, end - firstRelease);
  const handlerTime = Math.max(0, clock - delay);
  const cold = coldStartLine(run, input.ld_init_t, input.ld_M, 'ld_init_t', 'ld_M', 'batch');
  const partial = groups.filter(([size]) => size < batch);
  const partialLeads = partial.reduce((sum, [size, { count }]) => sum + size * count, 0);
  const handlerWarnings = [
    ...(batch < input.ld_batch
      ? [
          `A batch of ${input.ld_batch.toLocaleString('en-US')} leads at ${input.lead_b.toLocaleString('en-US')} bytes each is over the ${(invokePayloadBytes / 1024 / 1024).toFixed(0)} MB Lambda payload. The event source mapping invokes a handler with ${batch.toLocaleString('en-US')} leads instead.`,
        ]
      : []),
    ...(partialLeads > 0
      ? [
          `${partialLeads.toLocaleString('en-US')} ${partialLeads === 1 ? 'lead' : 'leads'} did not fill a batch of ${batch.toLocaleString('en-US')}. The event source mapping held them until the oldest waited ld_window_t = ${input.ld_window_t.toLocaleString('en-US')} ms, then invoked a handler with fewer leads.`,
        ]
      : []),
  ];
  const lines: ChargeLine[] = [
    {
      label: 'Lead consumption',
      detail: `The source handlers already paid for the sends. The event source mapping receives up to ${receiveLimit} leads per SQS call, and drops them with one delete-batch per ${receiveLimit} after the handler succeeds. SQS bills each 64 KB of one receive payload as one request at $0.40 per million. The receive is not a bar; the time is the start delay.`,
      time: figure(delay, '0 + delay_ld', `0 + ${delay} ms`),
      pure: price(
        consumption,
        `floor(ld_batch / ${receiveLimit}) × ceil(${receiveLimit} × lead_b / ${sqsChunkBytes}) + ceil((ld_batch mod ${receiveLimit}) × lead_b / ${sqsChunkBytes}) receives + ceil(ld_batch / ${receiveLimit}) deletes`,
        `${one.receives} × ${dollars(request)} + ${one.deletes} × ${dollars(request)}`,
        { SQS: consumption }
      ),
      applied: price(consumptionApplied, 'every batch × its consumption', terms(consumptionCost), {
        SQS: consumptionApplied,
      }),
    },
    {
      label: 'Handlers',
      ...(handlerWarnings.length > 0 ? { warning: handlerWarnings.join(' ') } : {}),
      detail: `Each batch is one Lambda invocation and its compute. The handler stores up to ld_c leads at once with OrderRepository.store, and pays compute while it waits for DynamoDB. It also pays while it waits for the tokens of the order write limit: ld_writes = ${input.ld_writes.toLocaleString('en-US')} writes a second for each environment. A handler that follows the previous batch waits ${wait.toLocaleString('en-US')} ms. A new environment has a full bucket, and an environment that rests fills its bucket again. A full batch logs ${logBytes.toLocaleString('en-US')} bytes: START, END, and REPORT, and one progress line for each ledger write. ${logDetail} ${slotDetail('L_q_c')} Running together does not reduce the bill.`,
      time: figure(
        handlerTime,
        'last lead bar end − first lead arrival',
        `T = ${input.ld_records_parse_t} + ${ledgerWaves} × ${input.ld_request_ledger_record_t} + ${wait > 0 ? `${wait.toLocaleString('en-US')} + ` : ''}ceil(${batch} / ${input.ld_c}) × ${input.ld_order_repository_store_t} + ${ledgerWaves} × ${input.ld_request_ledger_record_t} ms; ${end} − (${firstRelease} + ${delay}) ms`
      ),
      pure: price(
        handler,
        '1 invocation + (ceil(T) / 1000) s × (ld_M / 1024) GB × GB-second + log bytes / 2^30 × (log GB taken in + log GB kept one month)',
        [
          `1 × ${dollars(prices.lambdaRequest)}`,
          `${amount(seconds)} s × ${amount(gigabytes)} GB × ${dollars(prices.lambdaGbSecond)}`,
          `${amount(gigabytesOf(logBytes))} GB × (${dollars(prices.logIngestGb)} + ${dollars(prices.logStorageGbMonth)})`,
        ].join('\n+ '),
        { Lambda: pureLambda, 'CloudWatch Logs': logCost(batch) }
      ),
      applied: price(handlerApplied, 'every batch × its handler', terms(handlerCost), {
        Lambda: lambdaApplied,
        'CloudWatch Logs': logsApplied,
      }),
    },
    {
      label: 'Order writes',
      detail: `OrderRepository.store puts each lead into the orders table with one conditional PutItem. On-demand DynamoDB bills each 1 KB of the item as one write request unit at ${perMillion(prices.dynamoWriteUnit)}. A lead that is already stored still uses its units. The time is the store waves inside one handler bar. The table also keeps the orders: ${(storedGigabytes * 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB for this burst, at $${prices.dynamoStorageGbMonth} per GB-month, that is ${dollars(storedGigabytes * prices.dynamoStorageGbMonth)} each month. That storage is not in this bill.`,
      time: figure(
        storeTime,
        'ceil(ld_batch / ld_c) × ld_order_repository_store_t',
        `ceil(${batch} / ${input.ld_c}) × ${input.ld_order_repository_store_t} ms`
      ),
      pure: price(
        writes,
        'ld_batch × ceil(lead_b / 1024) units × write unit',
        `${batch} × ${units} × ${dollars(prices.dynamoWriteUnit)}`,
        { DynamoDB: writes }
      ),
      applied: price(writesApplied, 'every batch × its writes', terms(writeCost), { DynamoDB: writesApplied }),
    },
    {
      label: 'Ledger writes',
      detail: `A batch holds the leads of ld_requests = ${input.ld_requests.toLocaleString('en-US')} ${input.ld_requests === 1 ? 'request' : 'requests'}, at most one for each lead. RequestLedger.record updates the entry of each request two times: its leads pending after the parse, and its leads processed or failed after the stores. The handler writes up to ld_c entries at once, and never one write for each lead. ${ledgerDetail}`,
      time: figure(
        ledgerTime,
        '2 × ceil(min(ld_requests, ld_batch) / ld_c) × ld_request_ledger_record_t',
        `2 × ceil(${requests} / ${input.ld_c}) × ${input.ld_request_ledger_record_t} ms`
      ),
      pure: price(
        ledger,
        '2 × min(ld_requests, ld_batch) writes × ceil(entry bytes / 1024) units × write unit',
        `2 × ${requests} × ${requestEntryWriteUnits} × ${dollars(prices.dynamoWriteUnit)}`,
        { DynamoDB: ledger }
      ),
      applied: price(ledgerApplied, 'every batch × its ledger writes', terms(ledgerCost), { DynamoDB: ledgerApplied }),
    },
    cold,
  ];
  return {
    lines,
    time: figure(clock, 'last lead bar end − first lead release', `${delay} + ${handlerTime} ms`),
    pure: price(
      oneBatch,
      'consumption + handler + writes + ledger',
      `${dollars(consumption)} + ${dollars(handler)} + ${dollars(writes)} + ${dollars(ledger)}`,
      { SQS: consumption, Lambda: pureLambda, DynamoDB: writes + ledger, 'CloudWatch Logs': logCost(batch) }
    ),
    applied: price(
      consumptionApplied + handlerApplied + writesApplied + ledgerApplied + cold.applied.value,
      'every batch × (consumption + handler + writes + ledger) + cold starts',
      `${dollars(consumptionApplied)} + ${dollars(handlerApplied)} + ${dollars(writesApplied)} + ${dollars(ledgerApplied)} + ${dollars(cold.applied.value)}`,
      addSplits(
        {
          SQS: consumptionApplied,
          Lambda: lambdaApplied,
          DynamoDB: writesApplied + ledgerApplied,
          'CloudWatch Logs': logsApplied,
        },
        cold.applied.services
      )
    ),
  };
}

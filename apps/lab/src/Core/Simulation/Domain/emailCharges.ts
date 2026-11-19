import { billedSeconds, memoryGb, sesChunksOf } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';

import {
  coldStartLine,
  consumptionWarning,
  count,
  dollars,
  factor,
  figure,
  ledgerDetail,
  ledgerPrice,
  logDetail,
  logTerms,
  scaled,
  slotDetail,
  sumPrice,
  term,
  whole,
  amount,
  type ChargeLine,
  type Charges,
} from './charges';
import { inboxLedgerWrites, inboxMemory, inboxTimeline } from './inbox';
import { sesMaxBytes } from './limits';
import { inboxLogBytes, inboxProgressLines } from './logs';
import { emailBytes, inMegabytes, workbookBytes } from './payloads';
import { scheduleInbox } from './schedule';
import type { SliceInputs } from './sources';
import { timeOf } from './timeline';

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Inbox time is the clock the bars use: the start delay, then the inbox handlers on their slots.
 * Pure price is one email on a warm environment. Applied price is every email, plus INIT of every new environment.
 * SES bills each email and each 256 KB of it, and writes it to the inbox bucket with one S3 put.
 * An S3 notification is about 800 bytes. SQS bills each API call, and 64 KB or less is one request at $0.40 per million.
 */
export function emailCharges(
  input: SliceInputs,
  schedule: Pick<ReturnType<typeof scheduleInbox>, 'inbox'> = scheduleInbox(input)
): Charges {
  const run = schedule.inbox;
  const steps = inboxTimeline(input);
  const duration = steps.duration;
  const seconds = billedSeconds(duration);
  const gigabytes = memoryGb(inboxMemory);
  const request = prices.sqsRequest;
  const invocation = prices.lambdaRequest;
  const compute = seconds * gigabytes * prices.lambdaGbSecond;
  const read = prices.s3Get;
  const puts = input.S * prices.s3Put;
  const logBytes = inboxLogBytes();
  const handlerPrice = sumPrice(
    '1 invocation + (ceil(T) / 1000) s × (M / 1024) GB × GB-second + 1 read + S puts + log bytes',
    [
      term('Lambda', invocation, factor('1', 'invocation'), factor(dollars(invocation), 'Lambda request')),
      term(
        'Lambda',
        compute,
        factor(`${amount(seconds)} s`, 'ceil(T) / 1000'),
        factor(`${amount(gigabytes)} GB`, 'M / 1024'),
        factor(dollars(prices.lambdaGbSecond), 'GB-second')
      ),
      term('S3', read, factor('1', 'read'), factor(dollars(read), 'S3 GET')),
      term('S3', puts, factor(count(input.S), 'S puts'), factor(dollars(prices.s3Put), 'S3 PUT')),
      ...logTerms(logBytes, 'log bytes'),
    ]
  );
  const bytes = emailBytes(input);
  const chunks = sesChunksOf(bytes);
  const arrivalPrice = sumPrice('1 SES email + max(1, ceil(email bytes / 256 KB)) SES chunks + 1 put', [
    term('SES', prices.sesEmail, factor(dollars(prices.sesEmail), 'SES email')),
    term(
      'SES',
      chunks * prices.sesChunk,
      factor(count(chunks), 'max(1, ceil(email bytes / 256 KB)) chunks'),
      factor(dollars(prices.sesChunk), 'SES chunk')
    ),
    term('S3', prices.s3Put, factor('1', 'put'), factor(dollars(prices.s3Put), 'S3 PUT')),
  ]);
  const consumptionPrice = sumPrice('1 send + 1 receive + 1 delete, each $0.40 / 1,000,000', [
    term('SQS', request, factor('1', 'send'), factor(dollars(request), 'SQS request')),
    term('SQS', request, factor('1', 'receive'), factor(dollars(request), 'SQS request')),
    term('SQS', request, factor('1', 'delete'), factor(dollars(request), 'SQS request')),
  ]);
  const ledger = ledgerPrice(inboxLedgerWrites, 'ledger writes');
  const pure = sumPrice('arrival + consumption + handler + ledger', [
    whole(arrivalPrice, 'arrival'),
    whole(consumptionPrice, 'consumption'),
    whole(handlerPrice, 'handler'),
    whole(ledger, 'ledger'),
  ]);
  const cold = coldStartLine(run, input.in_init_t, inboxMemory, 'in_init_t', 'M', 'email');
  const end = run.end;
  const handlerTime = Math.max(0, end - input.delay_in);
  const putTerm = input.S === 0 ? '0' : `ceil(${input.S} / ${input.in_c})`;
  const emailMb = `${inMegabytes(bytes)} MB × ${input.in_storage_mb_t}`;
  const putMb = `${input.S} × ${inMegabytes(workbookBytes(input))} MB × ${input.in_storage_mb_t}`;
  const ledgerTime = timeOf(steps, 'ledger');
  const durationSubstitution = `${input.in_request_ledger_acknowledge_t} + ${input.in_storage_read_t} + ${emailMb} + ${input.in_email_parser_parse_t} + ${input.in_request_ledger_record_t} + ${putTerm} × ${input.in_storage_store_t} + ${putMb} + ${input.in_request_ledger_record_t} + ${input.in_storage_delete_t} ms`;
  const lines: ChargeLine[] = [
    {
      label: 'Email arrival',
      ...(bytes > sesMaxBytes
        ? {
            warning: `One email here is ${megabytes(bytes)}: ${input.S} workbooks of ${input.L.toLocaleString('en-US')} rows, base64 encoded. SES does not store an email larger than 40 MB in S3, so it never reaches the inbox and nothing below runs. The prices below are for an email SES could store.`,
          }
        : {}),
      detail: `SES receives the email and writes it to the inbox bucket with one S3 put. SES bills each email and each 256 KB chunk of it. One email is ${megabytes(bytes)}: headers, then ${input.S} workbooks of L rows at row_b bytes, base64 encoded.`,
      time: figure(0, '0', '0 ms'),
      pure: arrivalPrice,
      applied: sumPrice('E emails × one arrival', [scaled(arrivalPrice, input.E, 'E emails', 'one arrival')]),
    },
    {
      label: 'Email consumption',
      warning: consumptionWarning(input.E, request),
      detail:
        'S3 sends one notification per email, about 800 bytes. Each handler receives that message and deletes it. All three are one SQS request, because 64 KB is the request size at $0.40 per million. The send is not a bar; the time is the start delay.',
      time: figure(input.delay_in, '0 + delay_in', `0 + ${input.delay_in} ms`),
      pure: consumptionPrice,
      applied: sumPrice('E sends + E receives + E deletes', [
        term('SQS', input.E * request, factor(count(input.E), 'E sends'), factor(dollars(request), 'SQS request')),
        term('SQS', input.E * request, factor(count(input.E), 'E receives'), factor(dollars(request), 'SQS request')),
        term('SQS', input.E * request, factor(count(input.E), 'E deletes'), factor(dollars(request), 'SQS request')),
      ]),
    },
    {
      label: 'Handlers',
      detail: `Each email is one Lambda invocation, its compute, one S3 read, and one put per attachment. The handler then deletes the email from the inbox, and S3 delete is free. S3 bills a request at one price for any size, but the handler waits for the bytes: in_storage_mb_t ms per MB on top of the latency of each read and put. The puts of one wave share the network. One email is ${inMegabytes(bytes)} MB and one workbook ${inMegabytes(workbookBytes(input))} MB. Each handler logs ${count(logBytes)} bytes: START, END, and REPORT, the size of the email, and ${inboxProgressLines} progress lines. ${logDetail} ${slotDetail('E_q_c')} Running together does not reduce the bill.`,
      time: figure(
        handlerTime,
        'last inbox bar end − delay_in',
        `T = ${durationSubstitution}; ${end} − ${input.delay_in} ms`
      ),
      pure: handlerPrice,
      applied: sumPrice('E emails × one handler', [scaled(handlerPrice, input.E, 'E emails', 'one handler')]),
    },
    {
      label: 'Ledger writes',
      detail: `RequestLedger.acknowledge puts a new request entry with one conditional PutItem before the handler reads the email. RequestLedger.record then updates the entry two times: with the number of attachments before the first put, and with the end of the email after the last put. ${ledgerDetail}`,
      time: figure(
        ledgerTime,
        'in_request_ledger_acknowledge_t + 2 × in_request_ledger_record_t',
        `${input.in_request_ledger_acknowledge_t} + 2 × ${input.in_request_ledger_record_t} ms`
      ),
      pure: ledger,
      applied: sumPrice('E emails × one email of ledger writes', [
        scaled(ledger, input.E, 'E emails', 'ledger writes'),
      ]),
    },
    cold,
  ];
  return {
    lines,
    time: figure(end, 'last inbox bar end', `${input.delay_in} + ${handlerTime} ms`),
    pure,
    applied: sumPrice('E emails × (arrival + consumption + handler + ledger) + cold starts', [
      scaled(pure, input.E, 'E emails', 'one email'),
      whole(cold.applied, 'cold starts'),
    ]),
  };
}

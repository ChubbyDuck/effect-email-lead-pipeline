import {
  addSplits,
  billedSeconds,
  gigabytesOf,
  memoryGb,
  scaleSplit,
  type Service,
  type ServiceSplit,
} from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';

import { logIngestCost, logLineBytes, logStorageCost } from './logs';
import { ledgerWriteCost, requestEntryBytes, requestEntryWriteUnits } from './requestLedger';
import type { PoolRun } from './schedule';

export interface Figure {
  value: number;
  formula: string;
  substitution: string;
}

/** One factor of a price term: the value, and the symbol of the formula it stands for. */
export interface Factor {
  value: string;
  symbol: string;
}

/** One term of a price: its factors multiplied together, its price, and the services that bill it. */
export interface PriceTerm {
  factors: readonly Factor[];
  value: number;
  services: ServiceSplit;
}

/** A price, and the same price split by the AWS services that bill it. */
export interface PriceFigure extends Figure {
  services: ServiceSplit;
  /** The terms that add up to the price, when the price keeps each value next to its symbol. */
  terms?: readonly PriceTerm[];
}

export interface ChargeLine {
  label: string;
  detail: string;
  /** Shown from the warning icon on this row. */
  warning?: string;
  time: Figure;
  /** Price of this step for one email. */
  pure: PriceFigure;
  /** That price multiplied by the email count. Parallel waves do not reduce the bill. */
  applied: PriceFigure;
}

export interface Charges {
  lines: readonly ChargeLine[];
  /** Time to the end of this stage, then the price of one warm message, then every message and every cold start. */
  time: Figure;
  pure: PriceFigure;
  applied: PriceFigure;
}

export const figure = (value: number, formula: string, substitution: string): Figure => ({
  value,
  formula,
  substitution,
});

export const price = (value: number, formula: string, substitution: string, services: ServiceSplit): PriceFigure => ({
  ...figure(value, formula, substitution),
  services,
});

export const factor = (value: string, symbol: string): Factor => ({ value, symbol });

export const count = (value: number) => value.toLocaleString('en-US');

/** A term that one service bills in full, or that several services bill by `services`. */
export const term = (services: Service | ServiceSplit, value: number, ...factors: Factor[]): PriceTerm => ({
  factors,
  value,
  services: typeof services === 'string' ? { [services]: value } : services,
});

/** `times` copies of a price, for example every email × the price of one email. */
export const scaled = (price: PriceFigure, times: number, timesSymbol: string, priceSymbol: string): PriceTerm =>
  term(
    scaleSplit(price.services, times),
    times * price.value,
    factor(count(times), timesSymbol),
    factor(dollars(price.value), priceSymbol)
  );

/** A whole price as one term of a larger price. */
export const whole = (price: PriceFigure, symbol: string): PriceTerm =>
  term(price.services, price.value, factor(dollars(price.value), symbol));

/** A price that is the sum of its terms. The substitution lists the values of each term. */
export function sumPrice(formula: string, terms: readonly PriceTerm[]): PriceFigure {
  return {
    value: terms.reduce((sum, part) => sum + part.value, 0),
    formula,
    substitution: terms.map((part) => part.factors.map((each) => each.value).join(' × ')).join('\n+ '),
    services: addSplits(...terms.map((part) => part.services)),
    terms,
  };
}

/** Same trimming as the table's rate(), so a substitution shows the dollars the cell shows. */
export const dollars = (value: number) => {
  if (value === 0) return '$0.00';
  const trimmed = value.toFixed(12).replace(/(\.\d*?[1-9])0+$/, '$1');
  const fraction = trimmed.split('.')[1] ?? '';
  return fraction.length >= 2 ? `$${trimmed}` : `$${Number(trimmed).toFixed(2)}`;
};

export const amount = (value: number) => value.toFixed(12).replace(/\.?0+$/, '');

/** A unit price as AWS lists it, per million units, such as `$0.67 per million`. */
export const perMillion = (price: number) =>
  `$${(price * 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })} per million`;

/** The log lines of one handler as two terms: their bytes as GB × the ingest price, and × one month of storage. */
export const logTerms = (bytes: number, symbol: string) => {
  const gigabytes = factor(`${amount(gigabytesOf(bytes))} GB`, `${symbol} / 2^30`);
  return [
    term('CloudWatch Logs', logIngestCost(bytes), gigabytes, factor(dollars(prices.logIngestGb), 'log GB taken in')),
    term(
      'CloudWatch Logs',
      logStorageCost(bytes),
      gigabytes,
      factor(dollars(prices.logStorageGbMonth), 'log GB kept one month')
    ),
  ];
};

/** Text for the log lines: how CloudWatch Logs bills them. */
export const logDetail = `CloudWatch Logs bills each GB that a log group takes in at $${prices.logIngestGb}, and each GB that it keeps at $${prices.logStorageGbMonth} per month. The bill counts one month of storage. The log groups keep the lines with no end, so each later month adds the same storage again.`;

const batchLimit = 10;
const notificationBytes = 800;

/** Receive and delete can share a 64 KB chunk. S3 still sends one notification per object. */
export const consumptionWarning = (count: number, unit: number, noun = 'email', queue = 'inbox') => {
  const plural = `${noun}${count === 1 ? '' : 's'}`;
  const counted = count === batchLimit ? 'ten' : String(count);
  const groups = Math.ceil(count / batchLimit);
  const now = count * 3;
  const later = count + groups * 2;
  const shared =
    count <= batchLimit
      ? `so ${counted} 800-byte messages together are about ${Math.round((count * notificationBytes) / 1000)} KB and cost the same as one message: one request, ${dollars(unit)}`
      : `so ten 800-byte messages together are about 8 KB and cost the same as one message: one request, ${dollars(unit)}`;
  const batched =
    count <= batchLimit
      ? `Raising that to ${batchLimit} lets one receive return all ${counted} notifications, and one delete-batch drop all ${counted}, while the bodies still fit in 64 KB. Consumption for these ${count} ${plural} would go from ${now} requests (${dollars(now * unit)}) to ${later} (${dollars(later * unit)}): the ${count} sends, plus one receive, plus one delete.`
      : `Raising that to ${batchLimit} lets each receive return up to 10 notifications, and each delete-batch drop those, while a full batch still fits in 64 KB. Consumption for these ${count} ${plural} would go from ${now} requests (${dollars(now * unit)}) to ${later} (${dollars(later * unit)}): the ${count} sends, plus ${groups} receives, plus ${groups} deletes.`;
  const clock =
    count <= batchLimit
      ? `One Lambda invocation would hold all ${count} ${plural}, instead of ${count} handlers running together for T.`
      : `One Lambda invocation would hold up to ${batchLimit} ${plural}, instead of that many handlers running together for T.`;
  return [
    `Several messages can share one request when they travel in one API call. SQS chunks the payload of that call, ${shared}. A batch holds at most ${batchLimit} messages.`,
    `The ${counted} sends in this path cannot share a chunk. S3 writes one notification per object, and each of those is its own SQS request. Those stay ${count} × ${dollars(unit)}.`,
    `The receive and the delete can. The ${queue} queue is set to one message per call. ${batched}`,
    `That also changes the clock. ${clock}`,
  ].join('\n\n');
};

/**
 * INIT of the new execution environments of one stage.
 * Lambda bills INIT at the GB-second price for a managed runtime since 1 August 2025.
 */
export function coldStartLine(
  run: PoolRun,
  init: number,
  memory: number,
  symbol: string,
  memorySymbol: string,
  noun: string
): ChargeLine {
  const seconds = billedSeconds(init);
  const gigabytes = memoryGb(memory);
  const one = seconds * gigabytes * prices.lambdaGbSecond;
  const pure = sumPrice(`(ceil(${symbol}) / 1000) s × (${memorySymbol} / 1024) GB × GB-second + INIT log bytes`, [
    term(
      'Lambda',
      one,
      factor(`${amount(seconds)} s`, `ceil(${symbol}) / 1000`),
      factor(`${amount(gigabytes)} GB`, `${memorySymbol} / 1024`),
      factor(dollars(prices.lambdaGbSecond), 'GB-second')
    ),
    ...logTerms(logLineBytes.coldStart, 'INIT log bytes'),
  ]);
  return {
    label: 'Cold starts',
    detail: `A slot with no warm environment creates one. It runs INIT for ${symbol} before its first ${noun}, and the ${noun} waits for it. A free warm environment takes the next ${noun} with no INIT. Lambda bills INIT at the GB-second price. This time is inside the handler time above. A new environment also logs an INIT_START line and its init time on the REPORT line, ${logLineBytes.coldStart} bytes. ${logDetail}`,
    time: figure(run.environments > 0 ? init : 0, symbol, `${run.environments > 0 ? init : 0} ms`),
    pure,
    applied: sumPrice('environments × one INIT', [scaled(pure, run.environments, 'new environments', 'one INIT')]),
  };
}

/**
 * The writes of request entries in one stage, as one price: `writes` writes, each `requestEntryWriteUnits` write units.
 * `writesSymbol` names the count in the formula.
 */
export function ledgerPrice(writes: number, writesSymbol: string): PriceFigure {
  return sumPrice(`${writesSymbol} × ceil(entry bytes / 1024) units × write unit`, [
    term(
      'DynamoDB',
      ledgerWriteCost(writes),
      factor(count(writes), writesSymbol),
      factor(count(requestEntryWriteUnits), `ceil(${requestEntryBytes} / 1024) units`),
      factor(dollars(prices.dynamoWriteUnit), 'write unit')
    ),
  ]);
}

/** Text for the ledger writes: how DynamoDB bills a request entry. */
export const ledgerDetail = `On-demand DynamoDB bills each 1 KB of the item as one write request unit at ${perMillion(prices.dynamoWriteUnit)}. One request entry is about ${requestEntryBytes} bytes, so each write is ${requestEntryWriteUnits} ${requestEntryWriteUnits === 1 ? 'unit' : 'units'}. The time is inside the handler bar.`;

/** Text for the handler time: how the event source mapping fills its slots. */
export const slotDetail = (cap: string) =>
  `A free slot takes the next message at once. The event source mapping starts with esm_start handlers and adds esm_rate per minute while messages wait, up to ${cap}.`;

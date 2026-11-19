/**
 * What the deployed workflow costs: the usage that a snapshot measured in its window, at the list prices of the
 * Region. The costs exclude the free tier, taxes, data transfer, and AppConfig.
 */
import { billedSeconds, gigabytesOf, memoryGb, type Service, sesChunksOf } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';
import type { StageName } from '@leads/shared/domain/stages';

import type { Usage } from './snapshot';

/** In hours. A month of the projection. */
export const monthHours = 30 * 24;
/**
 * The SES chunks of the emails of a window. An email with a size line counts its real chunks. An email without one,
 * such as an email that the inbox did not read yet, counts one chunk: a minimum.
 */
function sesChunksLine(emails: number, emailBytes: readonly number[]): CostLine {
  const unmeasured = Math.max(0, emails - emailBytes.length);
  const measured = emailBytes.reduce((total, bytes) => total + sesChunksOf(bytes), 0);
  const note =
    emailBytes.length === 0
      ? 'One chunk for each email: the logs give no size of an email, so this is a minimum.'
      : unmeasured === 0
        ? 'The size line of each email that the inbox read gives its chunks.'
        : `The size lines give the chunks of ${emailBytes.length} of the ${emails} emails. Each other email is one chunk: a minimum.`;
  return line({
    service: 'SES',
    owner: 'inbox',
    item: 'chunks of 256 KB received',
    quantity: measured + unmeasured,
    unit: 'chunk',
    unitPrice: prices.sesChunk,
    note,
  });
}

/** The stage that causes a cost. The ledger is shared: every handler writes it, and the lab reads it. */
export type CostOwner = StageName | 'shared';

export interface CostLine {
  readonly service: Service;
  readonly owner: CostOwner;
  readonly item: string;
  readonly quantity: number;
  readonly unit: string;
  readonly unitPrice: number;
  readonly cost: number;
  /**
   * `work` grows with the requests. `idle` is the polling of the empty queues, which costs also without requests.
   * `monitor` is the reading of this lab.
   */
  readonly kind: 'work' | 'idle' | 'monitor';
  /** How exact the quantity is, when CloudWatch does not count it as AWS bills it. */
  readonly note?: string;
}

export interface CostReport {
  readonly windowHours: number;
  /** The costs of the window. */
  readonly lines: readonly CostLine[];
  readonly total: number;
  readonly work: number;
  readonly idle: number;
  readonly monitor: number;
  /** The costs of a month for what the stack keeps now, such as items and log lines. */
  readonly storage: readonly CostLine[];
  readonly storageTotal: number;
  /** A month at the rate of the window, with the storage of a month. */
  readonly perMonth: number;
  /** What one read of a snapshot costs in CloudWatch metric requests. */
  readonly perRead: number;
}

const line = (fields: Omit<CostLine, 'cost' | 'kind'> & { readonly kind?: CostLine['kind'] }): CostLine => ({
  kind: 'work',
  ...fields,
  cost: fields.quantity * fields.unitPrice,
});

const sum = (lines: readonly CostLine[]) => lines.reduce((total, { cost }) => total + cost, 0);

export function costsOf(usage: Usage, windowHours: number): CostReport {
  const lines: CostLine[] = [];
  for (const handler of usage.handlers) {
    const owner = handler.stage;
    lines.push(
      line({
        service: 'Lambda',
        owner,
        item: 'calls',
        quantity: handler.invocations,
        unit: 'call',
        unitPrice: prices.lambdaRequest,
      }),
      line({
        service: 'Lambda',
        owner,
        item: `compute at ${handler.memoryMb} MB`,
        quantity: (handler.durationMs / 1000) * memoryGb(handler.memoryMb),
        unit: 'GB-second',
        unitPrice: prices.lambdaGbSecond,
        note: 'Without the init time of cold starts, which CloudWatch does not count.',
      }),
      line({
        service: 'CloudWatch Logs',
        owner,
        item: 'log lines taken in',
        quantity: gigabytesOf(handler.logBytes),
        unit: 'GB',
        unitPrice: prices.logIngestGb,
      })
    );
  }

  for (const queue of usage.queues) {
    const owner = queue.stage;
    const name = queue.role === 'dlq' ? 'DLQ calls' : 'calls';
    lines.push(
      line({
        service: 'SQS',
        owner,
        item: `${name}: send, receive, delete`,
        quantity: queue.sent + queue.received + queue.deleted,
        unit: 'call',
        unitPrice: prices.sqsRequest,
        note: 'CloudWatch counts each message, and a batch call bills once, so this is a maximum.',
      }),
      line({
        service: 'SQS',
        owner,
        item: queue.role === 'dlq' ? 'DLQ empty polls' : 'empty polls of the trigger',
        quantity: queue.emptyReceives,
        unit: 'call',
        unitPrice: prices.sqsRequest,
        kind: 'idle',
      })
    );
  }

  // Each object that S3 stores sends one notification to the queue of its stage, and one handler reads it.
  const notified = (stage: StageName) =>
    usage.queues.find((queue) => queue.stage === stage && queue.role === 'main')?.sent ?? 0;
  const emails = notified('inbox');
  const sources = notified('leadSources');
  const fromNotifications = 'One for each object that S3 notified to the queue of the stage.';
  lines.push(
    line({
      service: 'S3',
      owner: 'inbox',
      item: 'PUT of the emails, by SES',
      quantity: emails,
      unit: 'call',
      unitPrice: prices.s3Put,
      note: fromNotifications,
    }),
    line({
      service: 'S3',
      owner: 'inbox',
      item: 'GET of the emails',
      quantity: emails,
      unit: 'call',
      unitPrice: prices.s3Get,
      note: fromNotifications,
    }),
    line({
      service: 'S3',
      owner: 'leadSources',
      item: 'PUT of the sources, by the inbox handler',
      quantity: sources,
      unit: 'call',
      unitPrice: prices.s3Put,
      note: fromNotifications,
    }),
    line({
      service: 'S3',
      owner: 'leadSources',
      item: 'GET of the sources',
      quantity: sources,
      unit: 'call',
      unitPrice: prices.s3Get,
      note: fromNotifications,
    }),
    line({
      service: 'SES',
      owner: 'inbox',
      item: 'emails received',
      quantity: emails,
      unit: 'email',
      unitPrice: prices.sesEmail,
    }),
    sesChunksLine(emails, usage.emailBytes)
  );

  for (const table of usage.tables) {
    const owner: CostOwner = table.role === 'orders' ? 'leads' : 'shared';
    lines.push(
      line({
        service: 'DynamoDB',
        owner,
        item: `${table.name} writes`,
        quantity: table.writeUnits,
        unit: 'write unit',
        unitPrice: prices.dynamoWriteUnit,
      }),
      table.role === 'ledger'
        ? line({
            service: 'DynamoDB',
            owner,
            item: `${table.name} reads by the live requests of this lab`,
            quantity: table.readUnits,
            unit: 'read unit',
            unitPrice: prices.dynamoReadUnit,
            kind: 'monitor',
            note: 'The lab scans the ledger every 2 s while a page is open. The handlers do not read it.',
          })
        : line({
            service: 'DynamoDB',
            owner,
            item: `${table.name} reads`,
            quantity: table.readUnits,
            unit: 'read unit',
            unitPrice: prices.dynamoReadUnit,
          })
    );
  }

  const tableGb = gigabytesOf(usage.tables.reduce((total, table) => total + table.sizeBytes, 0));
  const storage: CostLine[] = [
    line({
      service: 'DynamoDB',
      owner: 'shared',
      item: 'items kept',
      quantity: Math.max(0, tableGb - prices.dynamoFreeStorageGb),
      unit: 'GB-month',
      unitPrice: prices.dynamoStorageGbMonth,
      note: `The first ${prices.dynamoFreeStorageGb} GB of the account are free. DynamoDB updates the size about every six hours.`,
    }),
    ...usage.handlers.map((handler) =>
      line({
        service: 'CloudWatch Logs',
        owner: handler.stage,
        item: 'log lines kept',
        quantity: gigabytesOf(handler.logStoredBytes),
        unit: 'GB-month',
        unitPrice: prices.logStorageGbMonth,
        note: 'The log group keeps its lines with no end, so this cost grows each month.',
      })
    ),
  ];

  const kept = lines.filter(({ quantity }) => quantity > 0);
  const total = sum(kept);
  const idle = sum(kept.filter(({ kind }) => kind === 'idle'));
  const monitor = sum(kept.filter(({ kind }) => kind === 'monitor'));
  const storageTotal = sum(storage);
  return {
    windowHours,
    lines: kept.toSorted((a, b) => b.cost - a.cost),
    total,
    work: total - idle - monitor,
    idle,
    monitor,
    storage: storage.filter(({ quantity }) => quantity > 0),
    storageTotal,
    perMonth: (total * monthHours) / windowHours + storageTotal,
    perRead: usage.metricsPerRead * prices.metricRequested,
  };
}

/** The costs of the window, added up by a key such as the service or the owner, the largest first. */
export function costsBy<K extends string>(
  lines: readonly CostLine[],
  keyOf: (line: CostLine) => K
): { readonly key: K; readonly cost: number; readonly parts: readonly number[] }[] {
  const groups = new Map<K, number[]>();
  for (const item of lines) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item.cost]);
  return [...groups]
    .map(([key, parts]) => ({
      key,
      cost: parts.reduce((total, part) => total + part, 0),
      parts: parts.toSorted((a, b) => b - a),
    }))
    .toSorted((a, b) => b.cost - a.cost);
}

/** One locale for the server and the browser, as in the format of the page. */
const locale = 'en-GB';

/** An amount of US dollars. A cost of a fraction of a cent keeps three significant digits, such as `$0.000123`. */
export function dollars(value: number) {
  if (value === 0) return '$0';
  if (value >= 100) return `$${Math.round(value).toLocaleString(locale)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString(locale, { maximumSignificantDigits: 3 })}`;
}

/** A price as the price list gives it, with all its digits, such as `$0.0000166667`. */
export const rawDollars = (value: number) => `$${value.toLocaleString(locale, { maximumSignificantDigits: 12 })}`;

/** An exact small cost with at most 12 decimals, such as `$0.000214716669`, so a sum of parts shows no float noise. */
export function exactDollars(value: number) {
  if (value === 0) return '$0';
  return `$${value.toFixed(12).replace(/\.?0+$/, '')}`;
}

/** A small number with three significant digits, such as `0.000123`, and a large one as a whole number. */
export function amount(value: number) {
  if (value === 0 || Number.isInteger(value) || value >= 100) return Math.round(value).toLocaleString(locale);
  return value.toLocaleString(locale, { maximumSignificantDigits: 3 });
}

/** A cost, and how it was calculated from the raw prices. */
export interface Priced {
  readonly cost: number;
  readonly formula: string;
}

const seconds = (ms: number) => `${billedSeconds(ms).toLocaleString(locale, { maximumFractionDigits: 3 })} s`;
const perGbSecond = `${rawDollars(prices.lambdaGbSecond)} per GB-s`;
const perCall = `${rawDollars(prices.lambdaRequest)} per call`;

/** What Lambda time costs at a memory, without the call, such as the init time of a cold start. */
export const timePrice = (ms: number, memoryMb: number): Priced => ({
  cost: billedSeconds(ms) * memoryGb(memoryMb) * prices.lambdaGbSecond,
  formula: `${amount(memoryGb(memoryMb))} GB × ${seconds(ms)} × ${perGbSecond}`,
});

/** What a run of a duration costs at a memory: its call and its time. */
export function lambdaPrice(ms: number, memoryMb: number): Priced {
  const time = timePrice(ms, memoryMb);
  return { cost: prices.lambdaRequest + time.cost, formula: `${time.formula} + ${perCall}` };
}

/** What one Lambda run costs: its call, and its billed time at its memory. The billed time has the init time in it. */
export function runPrice(run: { readonly billedMs?: number; readonly memoryMb?: number }): Priced | undefined {
  if (run.billedMs === undefined || run.memoryMb === undefined) return undefined;
  return lambdaPrice(run.billedMs, run.memoryMb);
}

/** What some runs cost together: their GB-seconds and their calls. A run without a REPORT line has no billed time yet. */
export function runsPrice(runs: readonly { readonly billedMs?: number; readonly memoryMb?: number }[]): Priced {
  const billed = runs.flatMap(({ billedMs, memoryMb }) =>
    billedMs === undefined || memoryMb === undefined ? [] : [billedSeconds(billedMs) * memoryGb(memoryMb)]
  );
  const gbSeconds = billed.reduce((total, value) => total + value, 0);
  const calls = billed.length;
  return {
    cost: gbSeconds * prices.lambdaGbSecond + calls * prices.lambdaRequest,
    formula: `${amount(gbSeconds)} GB-s × ${perGbSecond} + ${amount(calls)} ${calls === 1 ? 'call' : 'calls'} × ${perCall}`,
  };
}

/** The cost of a line: its quantity at its raw unit price. */
export const lineFormula = (line: CostLine) => `${amount(line.quantity)} ${line.unit} × ${rawDollars(line.unitPrice)}`;

/** A sum of costs, with each part. */
export const sumFormula = (parts: readonly number[]) =>
  parts.length === 0 ? '$0' : parts.map((part) => dollars(part)).join(' + ');

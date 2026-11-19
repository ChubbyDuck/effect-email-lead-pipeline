import { services, splitShares, type Service, type ServiceSplit } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';
import { ChevronRight } from 'lucide-react';
import { memo, type ReactNode, Suspense, use, useEffect, useState } from 'react';

import { type RequestRead, shapeKeys } from '#Core/Observation/Domain/comparison';
import type { StackTotal } from '#Core/Simulation/Domain/burstCharges';
import type { Charges, Figure, PriceFigure, PriceTerm } from '#Core/Simulation/Domain/charges';
import type { IdleLine } from '#Core/Simulation/Domain/idleCharges';
import { leadBatchLimits } from '#Core/Simulation/Domain/leads';
import type { Limit } from '#Core/Simulation/Domain/limits';
import {
  normalizeSliceInputs,
  lambdaMemory,
  leadBatchSize,
  sliceDefaults,
  type SliceInputKey,
  type SliceInputs,
} from '#Core/Simulation/Domain/sources';

import {
  ComparisonNotes,
  type ComparisonState,
  CostComparison,
  ReadStatus,
  RequestField,
  StageComparison,
} from './Comparison';
import {
  ComparisonBar,
  RequestPicker,
  SummaryCost,
  SummaryFacts,
  summaryNotes,
  SummaryStages,
} from './ComparisonSummary';
import { duration, money, number, rate, seconds } from './format';
import { InboxLanes } from './InboxLanes';
import { useSimulation, useSummary } from './useSimulation';

const fields: [SliceInputKey, string][] = [
  ['N', 'Bursts / day'],
  ['E', 'Emails'],
  ['S', 'Sources / email'],
  ['L', 'Leads / source'],
  ['lead_b', 'Bytes / lead'],
  ['E_q_c', 'Inbox handlers at once'],
  ['in_c', 'Attachment puts at once'],
  ['S_q_c', 'Source handlers at once'],
  ['src_c', 'Batch sends at once'],
  ['L_q_c', 'Lead handlers at once'],
  ['ld_batch', 'Leads / lead handler'],
  ['ld_window_t', 'Batching window'],
  ['ld_c', 'Stores at once'],
  ['ld_writes', 'Order writes / second / lead environment'],
  ['ld_requests', 'Requests / lead handler'],
  ['esm_start', 'Handlers a queue starts with'],
  ['esm_rate', 'Handlers added / minute'],
  ['row_b', 'Bytes / workbook row'],
];
/** AWS sets these for an SQS event source mapping in on-demand mode. The mapping has no setting for them. */
const fixed = new Set<SliceInputKey>(['esm_start', 'esm_rate']);
/** The deployed setting behind an input: a shared setting of `@leads/shared`, which the stack deploys, or a key of the AppConfig runtime settings. */
const configAttributes: Partial<Record<SliceInputKey, string>> = {
  E_q_c: 'handlerSettings.stageCaps.inbox',
  in_c: 'AppConfig INBOX_INTERNAL_CONCURRENCY',
  S_q_c: 'handlerSettings.stageCaps.leadSources',
  src_c: 'AppConfig LEAD_SOURCES_INTERNAL_CONCURRENCY',
  L_q_c: 'handlerSettings.stageCaps.leads',
  ld_batch: 'handlerSettings.leadBatchSize',
  ld_window_t: 'handlerSettings.leadBatchingWindow',
  ld_c: 'AppConfig LEAD_INTERNAL_CONCURRENCY',
  ld_writes: 'orderWritesPerSecond.environment',
  src_M: 'handlerSettings.memorySize.leadSources',
  ld_M: 'handlerSettings.memorySize.leads',
};
const timings: SliceInputKey[] = [
  'delay_in',
  'in_request_ledger_acknowledge_t',
  'in_storage_read_t',
  'in_email_parser_parse_t',
  'in_storage_store_t',
  'in_storage_delete_t',
  'in_request_ledger_record_t',
  'in_storage_mb_t',
  'in_init_t',
];
const memorySettings: [SliceInputKey, string][] = [
  ['src_M', 'Source handler memory'],
  ['ld_M', 'Lead handler memory'],
];
const sourceTimings: SliceInputKey[] = [
  'delay_src',
  'src_request_ledger_record_t',
  'src_storage_read_t',
  'src_excel_sheet_parser_parse_t',
  'src_queue_push_t',
  'src_storage_delete_t',
  'src_storage_mb_t',
  'src_init_t',
];
const leadTimings: SliceInputKey[] = [
  'delay_ld',
  'ld_records_parse_t',
  'ld_order_repository_store_t',
  'ld_request_ledger_record_t',
  'ld_init_t',
];

function ChargeWarning({ text }: { text: string }) {
  return (
    <span className="charge-warning">
      <button type="button" className="charge-warning-icon" aria-label="Batching">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.2 22.2 21H1.8L12 3.2Z" />
          <path d="M12 9.2v5.2" />
          <circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <span className="charge-warning-tooltip" role="tooltip">
        {text}
      </span>
    </span>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path d="M4 2.5 7.5 6 4 9.5" />
    </svg>
  );
}

function ChargeTitle({ title, open, toggle }: { title: string; open: boolean; toggle: () => void }) {
  return (
    <tr className="charge-title">
      <th colSpan={4}>
        <button type="button" className="charge-toggle" aria-expanded={open} onClick={toggle}>
          <Chevron />
          {title}
        </button>
      </th>
    </tr>
  );
}

/** One categorical color per service, in the fixed order of `services`. Defined in styles.css. */
const serviceColor = (service: Service) => `var(--service-${service.toLowerCase().replace(/\s+/g, '-')})`;

const percent = (share: number) => {
  if (share > 0 && share < 0.001) return '<0.1%';
  return `${share >= 0.1 ? Math.round(share * 100) : Number((share * 100).toFixed(1))}%`;
};

/** A cost of one burst can be below the six decimals of money(), so it then keeps its digits. */
const burstMoney = (value: number) => (value > 0 && value < 0.000005 ? rate(value) : money(value));

const shareText = (part: { service: Service; cost: number; share: number }) =>
  `${part.service} ${rate(part.cost)} · ${percent(part.share)}`;

/** The share of each service in one price, as one stacked bar. A hover names a segment; the list under it reads the same split. */
function ServiceBar({ split, large = false }: { split: ServiceSplit; large?: boolean }) {
  const parts = splitShares(split);
  if (parts.length === 0) return null;
  return (
    <span className={`service-bar${large ? ' service-bar-large' : ''}`} aria-hidden="true">
      {parts.map((part) => (
        <span
          key={part.service}
          className="service-segment"
          style={{ flexGrow: part.share, background: serviceColor(part.service) }}
          title={shareText(part)}
        />
      ))}
    </span>
  );
}

/** The services of one price with their dollars and share, so a color is never the only label. */
function ServiceList({ split, format = rate }: { split: ServiceSplit; format?: (value: number) => string }) {
  const parts = splitShares(split);
  if (parts.length === 0) return null;
  return (
    <ul className="service-list">
      {parts.map((part) => (
        <li key={part.service}>
          <i style={{ background: serviceColor(part.service) }} />
          <span className="service-name">{part.service}</span>
          <span className="service-cost">{format(part.cost)}</span>
          <span className="service-share">{percent(part.share)}</span>
        </li>
      ))}
    </ul>
  );
}

type ChargeCell = { figure: Figure | PriceFigure; format: (value: number) => string; span?: number };

/** One line of values; a click on the label shows the description and the formulas under it. */
function ChargeRow({
  label,
  warning,
  detail,
  cells,
  total = false,
}: {
  label: string;
  warning?: string | undefined;
  detail?: string;
  cells: readonly ChargeCell[];
  total?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const kind = total ? 'charge-total' : 'charge-line';
  return (
    <>
      <tr className={`charge-row ${kind}${open ? ' charge-open' : ''}`}>
        <th>
          <span className="charge-label">
            <button type="button" className="charge-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <Chevron />
              {label}
            </button>
            {warning ? <ChargeWarning text={warning} /> : null}
          </span>
        </th>
        {cells.map((cell, index) => (
          <td key={index} colSpan={cell.span}>
            <ChargeValue text={cell.format(cell.figure.value)} />
            {'services' in cell.figure ? <ServiceBar split={cell.figure.services} /> : null}
          </td>
        ))}
      </tr>
      {open ? (
        <tr className={`charge-detail ${kind}`}>
          <th>{detail}</th>
          {cells.map((cell, index) => (
            <td key={index} colSpan={cell.span}>
              <ChargeFormula figure={cell.figure} format={cell.format} />
              {'services' in cell.figure ? <ServiceList split={cell.figure.services} format={cell.format} /> : null}
            </td>
          ))}
        </tr>
      ) : null}
    </>
  );
}

function ChargesTableView({
  title,
  caption,
  pureLabel,
  appliedLabel,
  charges,
}: {
  title: string;
  caption: string;
  pureLabel: string;
  appliedLabel: string;
  charges: Charges;
}) {
  const [open, setOpen] = useState(false);
  const cells = (figures: Pick<Charges, 'time' | 'pure' | 'applied'>): ChargeCell[] => [
    { figure: figures.time, format: seconds },
    { figure: figures.pure, format: rate },
    { figure: figures.applied, format: rate },
  ];
  return (
    <table className="email-charges">
      <caption>{caption}</caption>
      <colgroup>
        <col className="charge-step" />
        <col className="charge-time" />
        <col className="charge-price" />
        <col className="charge-price" />
      </colgroup>
      <thead>
        <ChargeTitle title={title} open={open} toggle={() => setOpen(!open)} />
        <tr>
          <th>Step</th>
          <th>Time</th>
          <th>
            Pure
            <span>{pureLabel}</span>
          </th>
          <th>
            Applied
            <span>{appliedLabel}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {open &&
          charges.lines.map((line) => (
            <ChargeRow
              key={line.label}
              label={line.label}
              warning={line.warning}
              detail={line.detail}
              cells={cells(line)}
            />
          ))}
        <ChargeRow label="Total" cells={cells(charges)} total />
      </tbody>
    </table>
  );
}

/** Cost, time, and volume of the whole burst, read at a glance before the details below. */
function TotalTilesView({ total, inputs }: { total: StackTotal; inputs: SliceInputs }) {
  const sources = inputs.E * inputs.S;
  const leads = sources * inputs.L;
  const plural = (count: number, noun: string) => `${number(count)} ${noun}${count === 1 ? '' : 's'}`;
  return (
    <div className="summary-grid wave-tiles">
      <div className="metric">
        <span className="metric-label">Total cost</span>
        <span className="metric-value">
          {money(total.cost.value)}
          <span className="metric-unit"> / month</span>
        </span>
        <span className="metric-value metric-value-burst">
          {money(total.perBurst)}
          <span className="metric-unit"> / burst</span>
        </span>
        <span className="metric-note">
          {total.parts
            .map((part, index) => `${index === 0 ? part.label : part.label.toLowerCase()} ${money(part.cost)}`)
            .join(' + ')}{' '}
          (one month, {plural(total.bursts, 'burst')}). One burst is the month divided by its bursts, with its share of
          idle polling.
        </span>
      </div>
      <div className="metric">
        <span className="metric-label">Total time</span>
        <span className="metric-value">{duration(total.time.value)}</span>
        <span className="metric-note">One burst, from the first email to the end of the last lead handler.</span>
      </div>
      <div className="metric">
        <span className="metric-label">Emails processed</span>
        <span className="metric-value">{number(inputs.E)}</span>
        <span className="metric-note">
          {plural(sources, 'source')} and {plural(leads, 'lead')} from them in one burst.{' '}
          {plural(total.bursts * inputs.E, 'email')} in one month.
        </span>
      </div>
    </div>
  );
}

/** The total by service, for the month and for one burst: which part of AWS the money goes to. */
function ServiceBreakdownView({ total }: { total: StackTotal }) {
  const parts = splitShares(total.cost.services);
  return (
    <section className="service-breakdown" aria-label="Total cost by service">
      <div className="service-breakdown-heading">
        <span className="metric-label">Total cost by service</span>
        <span className="metric-note">
          One month, every burst plus idle polling. One burst is the month divided by its bursts.
        </span>
      </div>
      <ServiceBar split={total.cost.services} large />
      <ul className="service-legend">
        {services.map((service) => {
          const part = parts.find((candidate) => candidate.service === service);
          return (
            <li key={service} className={part ? undefined : 'service-free'}>
              <i style={{ background: serviceColor(service) }} />
              <span className="service-name">{service}</span>
              <span className="service-cost">{money(part?.cost ?? 0)}</span>
              <span className="service-unit">/ month</span>
              <span className="service-cost">{burstMoney(total.perBurstServices[service] ?? 0)}</span>
              <span className="service-unit">/ burst</span>
              <span className="service-share">{part ? percent(part.share) : '0%'}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LimitAlertsView({ limits }: { limits: readonly Limit[] }) {
  if (limits.length === 0) return null;
  return (
    <div className="limit-alerts" role="alert">
      <strong>The deployed app cannot run these inputs.</strong>
      <ul>
        {limits.map((limit) => (
          <li key={limit.title}>
            <span>{limit.title}</span>
            {limit.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

function IdleTableView({ lines, requests, cost }: { lines: readonly IdleLine[]; requests: Figure; cost: Figure }) {
  const [open, setOpen] = useState(false);
  const count = (value: number) => number(Math.round(value));
  return (
    <table className="email-charges idle-charges">
      <caption>
        The event source mappings poll each queue while it is empty. This is a monthly cost of the stack, not a cost of
        one burst. The total cost at the top adds it to the burst. The poller count and the wait are estimates.
      </caption>
      <colgroup>
        <col className="charge-step" />
        <col className="charge-time" />
        <col className="charge-price" />
        <col className="charge-price" />
      </colgroup>
      <thead>
        <ChargeTitle title="Idle polling · per month" open={open} toggle={() => setOpen(!open)} />
        <tr>
          <th>Queue</th>
          <th>Requests</th>
          <th colSpan={2}>Cost</th>
        </tr>
      </thead>
      <tbody>
        {open &&
          lines.map((line) => (
            <ChargeRow
              key={line.label}
              label={line.label}
              detail={line.detail}
              cells={[
                { figure: line.requests, format: count },
                { figure: line.cost, format: rate, span: 2 },
              ]}
            />
          ))}
        <ChargeRow
          label="Total"
          cells={[
            { figure: requests, format: count },
            { figure: cost, format: rate, span: 2 },
          ]}
          total
        />
      </tbody>
    </table>
  );
}

/** Dims the zeros before the first significant digit of a price, so the size of a small price shows at a glance. */
function ChargeValue({ text }: { text: string }) {
  const [, zeros, digits] = /^(\$0\.0*)(\d.*)$/.exec(text) ?? [text, '', text];
  return (
    <span className="charge-value">
      {zeros ? <span className="charge-zeros">{zeros}</span> : null}
      {digits}
    </span>
  );
}

/** The service color of a term that one service bills. A term of several services has no color. */
const termColor = (part: PriceTerm) => {
  const [only, ...rest] = splitShares(part.services);
  return only && rest.length === 0 ? serviceColor(only.service) : undefined;
};

/**
 * Each value sits above the symbol it stands for, so the formula and its numbers read as one line.
 * A term with more than one factor shows its own price; the last line is the sum.
 */
function PriceTerms({
  terms,
  value,
  format,
}: {
  terms: readonly PriceTerm[];
  value: number;
  format: (value: number) => string;
}) {
  const color = (part: PriceTerm) => termColor(part) ?? 'transparent';
  return (
    <span className="charge-formula price-terms">
      {terms.map((part, index) => (
        <span key={index} className="price-term" style={{ borderLeftColor: color(part) }}>
          <span className="term-operator">{index === 0 ? '' : '+'}</span>
          <span className="term-factors">
            {part.factors.map((each, position) => (
              // The × goes with the factor after it, so a wrapped line starts with the multiplication it continues.
              <span key={position} className="term-factor">
                {position > 0 ? <span className="term-times">×</span> : null}
                <span className="term-pair">
                  <span className="term-value">{each.value}</span>
                  <span className="term-symbol">{each.symbol}</span>
                </span>
              </span>
            ))}
          </span>
          {part.factors.length > 1 && terms.length > 1 ? (
            <span className="term-result">{format(part.value)}</span>
          ) : null}
        </span>
      ))}
      <span className="price-term price-term-sum">
        <span className="term-operator">=</span>
        <span className="term-sum">{format(value)}</span>
      </span>
    </span>
  );
}

function ChargeFormula({ figure, format }: { figure: Figure | PriceFigure; format: (value: number) => string }) {
  if ('terms' in figure && figure.terms)
    return <PriceTerms terms={figure.terms} value={figure.value} format={format} />;
  return (
    <span className="charge-formula">
      <code>{figure.formula}</code>
      <span>
        {figure.substitution} = {format(figure.value)}
      </span>
    </span>
  );
}

/** These change only with the inputs, so playback does not draw them again. */
const ChargesTable = memo(ChargesTableView);
const LimitAlerts = memo(LimitAlertsView);
const TotalTiles = memo(TotalTilesView);
const ServiceBreakdown = memo(ServiceBreakdownView);
const IdleTable = memo(IdleTableView);

function PlaybackIcon({ name }: { name: 'start' | 'play' | 'pause' | 'end' }) {
  return (
    <svg className={name === 'play' ? 'icon-play' : undefined} viewBox="0 0 24 24" aria-hidden="true">
      {name === 'start' && (
        <>
          <rect x="3.75" y="4.75" width="2.25" height="14.5" rx="0.75" />
          <path d="M19.5 5.15 8.4 12l11.1 6.85V5.15Z" />
        </>
      )}
      {name === 'play' && <path d="M9.2 5.15 19.4 12 9.2 18.85V5.15Z" />}
      {name === 'pause' && (
        <>
          <rect x="7" y="4.75" width="3.2" height="14.5" rx="1.05" />
          <rect x="13.8" y="4.75" width="3.2" height="14.5" rx="1.05" />
        </>
      )}
      {name === 'end' && (
        <>
          <path d="M4.5 5.15 15.6 12 4.5 18.85V5.15Z" />
          <rect x="18" y="4.75" width="2.25" height="14.5" rx="0.75" />
        </>
      )}
    </svg>
  );
}

const shaped = new Set<SliceInputKey>(shapeKeys);

/** A panel that folds on its heading. Its content stays on the page while it is closed, so it keeps its state. */
function FoldPanel({
  eyebrow,
  title,
  open,
  onOpen,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly open: boolean;
  readonly onOpen: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  return (
    <section className="panel wave-panel">
      <details className="panel-fold" open={open} onToggle={(event) => onOpen(event.currentTarget.open)}>
        <summary className="panel-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2>{title}</h2>
          </div>
          <ChevronRight className="panel-fold-mark" />
        </summary>
        {children}
      </details>
    </section>
  );
}

/** The page holds this list while it has no reads, so that a read of the summary does not run again. */
const noReads: readonly RequestRead[] = [];

/** Waits for the reads of the requests, then gives their results to the page. */
function Resolved({
  promise,
  children,
}: {
  readonly promise: Promise<readonly RequestRead[]>;
  readonly children: (reads: readonly RequestRead[]) => ReactNode;
}) {
  return children(use(promise));
}

/**
 * The burst simulator. With requests, the page reads the entry and the runs of each, and draws them with the model. The
 * knobs of the person and the open state of the panels stay here, so a read or a clear of the requests does not reset
 * them.
 */
export function SimulatorApp({
  requests,
  comparison,
  onRequests,
}: {
  /** The IDs of the requests to compare, from the URL. */
  readonly requests: readonly string[];
  readonly comparison?: Promise<readonly RequestRead[]> | undefined;
  readonly onRequests: (requestIDs: readonly string[]) => void;
}) {
  const [inputs, setInputs] = useState<SliceInputs>({ ...sliceDefaults });
  const [costOpen, setCostOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const page = (result: readonly RequestRead[] | 'loading' | undefined) => (
    <SimulatorPage
      ownInputs={inputs}
      setInputs={setInputs}
      requests={requests}
      result={result}
      onRequests={onRequests}
      costOpen={costOpen}
      onCostOpen={setCostOpen}
      timelineOpen={timelineOpen}
      onTimelineOpen={setTimelineOpen}
    />
  );
  if (requests.length === 0 || comparison === undefined) return page(undefined);
  return (
    <Suspense fallback={page('loading')}>
      <Resolved promise={comparison}>{page}</Resolved>
    </Suspense>
  );
}

function SimulatorPage({
  ownInputs,
  setInputs,
  requests,
  result,
  onRequests,
  costOpen,
  onCostOpen,
  timelineOpen,
  onTimelineOpen,
}: {
  readonly ownInputs: SliceInputs;
  readonly setInputs: (update: (current: SliceInputs) => SliceInputs) => void;
  readonly requests: readonly string[];
  readonly result: readonly RequestRead[] | 'loading' | undefined;
  readonly onRequests: (requestIDs: readonly string[]) => void;
  readonly costOpen: boolean;
  readonly onCostOpen: (open: boolean) => void;
  readonly timelineOpen: boolean;
  readonly onTimelineOpen: (open: boolean) => void;
}) {
  const reads = result === undefined || result === 'loading' ? noReads : result;
  const state: ComparisonState =
    requests.length === 0
      ? { kind: 'none' }
      : result === undefined || result === 'loading'
        ? { kind: 'loading', requestIDs: requests }
        : { kind: 'ready', reads };
  // The picked request sets the knobs and draws the timeline, also while the tables show all the requests.
  const [picked, setPicked] = useState<string>();
  const [allShown, setAllShown] = useState(true);
  const readable = reads.flatMap((read) => (read.result.ok ? [read.result] : []));
  const loaded = readable.find(({ entry }) => entry.requestID === picked) ?? readable[0];
  const summary = useSummary(ownInputs, reads);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { simulation, compared, horizon } = useSimulation(ownInputs, loaded);
  const comparison = compared?.comparison ?? null;
  // The bar and the tables are parts of the compare panel, so that the bar can float past the end of the panel.
  const floating = reads.length > 1;
  const joined = summary !== null || compared !== null;
  const inputs = compared?.knobs ?? ownInputs;
  const { schedule, limits, flagged, month: total } = simulation;
  const { email: charges, sources: sourceBill, leads: leadBill, burst, idle } = simulation.charges;
  const batches = schedule.leads.started.at(-1) ?? 0;
  const shown = Math.min(time, horizon);
  useEffect(() => {
    if (!playing || horizon === 0) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      let reachedEnd = false;
      setTime((current) => {
        const next = current + (horizon * delta) / 8000;
        if (next >= horizon) {
          reachedEnd = true;
          return horizon;
        }
        return next;
      });
      if (reachedEnd) setPlaying(false);
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, horizon]);
  const change = (key: SliceInputKey, value: number) => {
    setInputs((current) => normalizeSliceInputs({ ...current, [key]: value }));
    setTime(0);
    setPlaying(false);
  };
  const seek = (next: number) => {
    setPlaying(false);
    setTime(Math.min(horizon, Math.max(0, next)));
  };
  const field = (key: SliceInputKey, label?: string) => {
    const timeField = key.endsWith('_t') || key.startsWith('delay_');
    const bytesField = key === 'lead_b' || key === 'row_b';
    const memoryField = key === 'src_M' || key === 'ld_M';
    const shapeField = compared !== null && shaped.has(key);
    const fixedField = fixed.has(key) || shapeField;
    const tooltip = shapeField
      ? `Set by the request ${loaded?.entry.requestID ?? ''}. Clear the request to change it.`
      : fixed.has(key)
        ? 'Set by AWS for an on-demand SQS event source mapping'
        : configAttributes[key];
    return (
      <label
        className={`${label ? 'knob' : 'knob timing-knob'}${flagged.has(key) ? ' knob-invalid' : ''}${fixedField ? ' knob-fixed' : ''}`}
        key={key}
      >
        <span className="knob-label">
          <code>{key}</code>
          {label ? <span>{label}</span> : null}
          {tooltip ? (
            <span className="knob-tooltip" role="tooltip">
              {tooltip}
            </span>
          ) : null}
        </span>
        <span className="knob-input">
          <input
            type="number"
            aria-label={label ? `${key} · ${label}` : key}
            aria-invalid={flagged.has(key) || undefined}
            value={inputs[key]}
            min={
              timeField || bytesField || key === 'S' || key === 'L' || key === 'esm_rate'
                ? 0
                : memoryField
                  ? lambdaMemory.min
                  : 1
            }
            max={
              memoryField
                ? lambdaMemory.max
                : key === 'ld_batch'
                  ? leadBatchLimits.maxBatch
                  : key === 'ld_window_t'
                    ? leadBatchLimits.maxWindow
                    : undefined
            }
            step={timeField ? 'any' : 1}
            readOnly={fixedField}
            onChange={(event) => change(key, event.target.valueAsNumber)}
          />
          {timeField && <span>{key.endsWith('_mb_t') ? 'ms/MB' : 'ms'}</span>}
          {bytesField && <span>B</span>}
          {memoryField && <span>MB</span>}
        </span>
      </label>
    );
  };
  return (
    <div className="simulator wave-app">
      <div className="workspace">
        <aside className="controls" aria-label="Inbox slice controls">
          <div className="sidebar-heading">
            <span className="eyebrow">Version 3 inputs</span>
            <span className="live-dot">Live</span>
          </div>
          <p className="sidebar-description">
            Emails, the three stage caps, how many puts, batch sends, or stores run at once inside a handler, and the
            bytes in one queued lead. A source handler sends its leads in batches of {leadBatchSize}.
          </p>
          <div className="control-group">{fields.map(([key, label]) => field(key, label))}</div>
          <div className="control-group">{memorySettings.map(([key, label]) => field(key, label))}</div>
          <div className="timing-groups">
            <details>
              <summary>
                Inbox timings
                <span>ms</span>
              </summary>
              <div>{timings.map((key) => field(key))}</div>
            </details>
            <details>
              <summary>
                Source timings
                <span>ms</span>
              </summary>
              <div>{sourceTimings.map((key) => field(key))}</div>
            </details>
            <details>
              <summary>
                Lead timings
                <span>ms</span>
              </summary>
              <div>{leadTimings.map((key) => field(key))}</div>
            </details>
          </div>
          <div className="sidebar-note">
            <strong>Leads go to the queue in batches of {leadBatchSize}.</strong>
            <p>
              One <code>Queue.pushBatch</code> call is one SQS <code>SendMessageBatch</code> request. A send wave pushes
              up to <code>src_c</code> batches at once.
            </p>
          </div>
          <div className="sidebar-note">
            <strong>A free slot takes the next message at once.</strong>
            <p>
              Each queue starts with <code>esm_start</code> handlers and adds <code>esm_rate</code> per minute while
              messages wait, up to its cap. A new slot is a new environment, which runs INIT first.
            </p>
          </div>
          <div className="sidebar-note">
            <strong>A lead handler takes a batch of leads.</strong>
            <p>
              The leads queue hands one handler up to <code>ld_batch</code> leads. A full batch goes at once. A partial
              batch goes once its oldest lead has waited <code>ld_window_t</code>.
            </p>
          </div>
          <div className="sidebar-note">
            <strong>Each lead environment writes at a fixed rate.</strong>
            <p>
              A store takes one token from a bucket of <code>ld_writes</code> a second. A new environment has a full
              bucket. A handler that follows the previous batch waits for all its tokens, and Lambda bills that wait.
            </p>
          </div>
        </aside>
        <main>
          <div className="page-heading">
            <div>
              <span className="eyebrow">Emails · inbox · sources · leads · lead handlers</span>
              <h1>
                Burst simulator<span className="title-period">.</span>
              </h1>
              <p>Zoom the clock to read a bar. The time above each bar is how long that handler runs.</p>
            </div>
            <button
              onClick={() => {
                setInputs(() => ({ ...sliceDefaults }));
                setTime(0);
                setPlaying(false);
              }}
            >
              Reset sketch
            </button>
          </div>
          <section
            className={`panel compare-panel${floating || joined ? ' compare-panel-top' : ''}`}
            aria-label="Compare with requests"
          >
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Model and logs</span>
                <h2>Compare with requests</h2>
              </div>
            </div>
            <RequestField requests={requests} state={state} onRequests={onRequests} />
          </section>
          {floating ? (
            <ComparisonBar>
              <ReadStatus state={state} />
              <RequestPicker
                reads={reads}
                summary={summary}
                allShown={allShown}
                shown={loaded?.entry.requestID}
                onAll={() => setAllShown(true)}
                onRequest={(requestID) => {
                  setPicked(requestID);
                  setAllShown(false);
                }}
              />
              {summary !== null && allShown ? <SummaryFacts summary={summary} /> : null}
            </ComparisonBar>
          ) : null}
          {joined ? (
            <section className="panel compare-panel compare-panel-rest" aria-label="The comparison">
              {/* The summary only hides, so that its cells keep their switches while one request shows. */}
              {summary !== null ? (
                <div hidden={!allShown}>
                  <SummaryStages summary={summary} reads={reads} />
                  <SummaryCost summary={summary} reads={reads} />
                  <ComparisonNotes notes={summaryNotes(summary, reads)} />
                </div>
              ) : null}
              {compared !== null && (summary === null || !allShown) ? (
                <>
                  <StageComparison comparison={compared.comparison} model={simulation.lanes} />
                  <CostComparison burst={burst} real={compared.cost} />
                  <ComparisonNotes notes={compared.comparison.notes} />
                </>
              ) : null}
            </section>
          ) : null}
          <TotalTiles total={total} inputs={inputs} />
          <ServiceBreakdown total={total} />
          <LimitAlerts limits={limits} />
          <FoldPanel
            eyebrow="Cost of one burst"
            title="Inbox, source, and lead handlers"
            open={costOpen}
            onOpen={onCostOpen}
          >
            <ChargesTable
              title="Inbox"
              caption={`Time is the shared clock through the last inbox bar. Pure is one email on a warm environment. Applied is every email, plus INIT of every new environment. Prices are for ${prices.region}.`}
              pureLabel="1 email"
              appliedLabel={`${inputs.E} ${inputs.E === 1 ? 'email' : 'emails'}`}
              charges={charges}
            />
            <ChargesTable
              title="Sources"
              caption="Time is the source-handler clock: from the first source the inbox releases to the end of the last source bar. Pure is one source on a warm environment. Applied is every source, plus INIT of every new environment."
              pureLabel="1 source"
              appliedLabel={`${inputs.E * inputs.S} ${inputs.E * inputs.S === 1 ? 'source' : 'sources'}`}
              charges={sourceBill}
            />
            <ChargesTable
              title="Leads"
              caption="Time is the lead-handler clock: from the first lead the source handlers push to the end of the last lead bar. Pure is one full batch on a warm environment. Applied is every batch, plus INIT of every new environment. OrderRepository.store puts each lead into DynamoDB on demand. The bill counts the write units, not the monthly storage."
              pureLabel="1 batch"
              appliedLabel={`${number(batches)} ${batches === 1 ? 'batch' : 'batches'}`}
              charges={leadBill}
            />
            <ChargesTable
              title="Inbox, sources, and leads"
              caption="Time is the shared clock until the last bar ends. Each stage starts while the one before it still runs, so the clocks overlap and do not add. Pure is one email with its sources and their leads on warm environments. Applied is every email and every cold start of one burst. The total cost at the top multiplies the applied price by N bursts a day for 30 days, then adds one month of idle polling. The handlers delete each email and each source they end, so a burst leaves no file in S3."
              pureLabel={`1 email · ${inputs.S} ${inputs.S === 1 ? 'source' : 'sources'}`}
              appliedLabel={`${inputs.E} ${inputs.E === 1 ? 'email' : 'emails'} · ${inputs.E * inputs.S} ${inputs.E * inputs.S === 1 ? 'source' : 'sources'}`}
              charges={burst}
            />
            <IdleTable lines={idle.lines} requests={idle.requests} cost={idle.cost} />
          </FoldPanel>
          <FoldPanel
            eyebrow="Shared clock"
            title="Timeline of the handlers"
            open={timelineOpen}
            onOpen={onTimelineOpen}
          >
            <div className="wave-transport">
              <div className="wave-transport-controls">
                <button type="button" className="transport" aria-label="Start" onClick={() => setTime(0)}>
                  <PlaybackIcon name="start" />
                </button>
                <button
                  type="button"
                  className="transport transport-play"
                  aria-label={playing ? 'Pause' : 'Play'}
                  aria-pressed={playing}
                  disabled={horizon === 0}
                  onClick={() => setPlaying((current) => !current)}
                >
                  <PlaybackIcon name={playing ? 'pause' : 'play'} />
                </button>
                <button
                  type="button"
                  className="transport"
                  aria-label="End"
                  disabled={horizon === 0}
                  onClick={() => {
                    setPlaying(false);
                    setTime(horizon);
                  }}
                >
                  <PlaybackIcon name="end" />
                </button>
              </div>
              <output className="wave-clock">{(shown / 1000).toFixed(3)} s</output>
            </div>
            <InboxLanes
              key={comparison?.requestID ?? 'model'}
              real={comparison}
              simulation={simulation}
              horizon={horizon}
              time={shown}
              onTime={seek}
            />
            <p className="panel-description">
              A wave is the handlers that start together on the same kind of environment. A cold wave starts with INIT,
              so it ends later than a warm wave that starts with it. When the wave holds every email, the brace reads E
              out of E_q_c. When it holds every source, it reads E×S out of S_q_c. When it holds every lead batch, it
              reads the batches out of L_q_c. Otherwise it is × and the count. Colors inside a bar are that handler's
              timings, drawn to the clock. A short timing is a sliver until you zoom. The time above a bar is the
              handler's duration. Hover a range to mark its start and end on the axis. The tooltip names the service
              call and what that range releases. Dashed lines run from those times down to the range. Dots mean the rest
              of the wave is in that count. Click a handler title to zoom out to its swarm: the time from the first
              handler to the last, the handlers that run at once, and the output that is in flight at once.
            </p>
          </FoldPanel>
        </main>
      </div>
    </div>
  );
}

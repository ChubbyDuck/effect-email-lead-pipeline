import { type Service, type ServiceSplit, splitShares } from '@leads/shared/domain/billing';
import { prices } from '@leads/shared/domain/prices';
import { type StageName, stageLabels } from '@leads/shared/domain/stages';
import { cn } from '@leads/ui/lib/utils';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { exactDollars } from '#Core/Observation/Domain/costs';
import { type CostTerm, type RequestCost, type StageCost } from '#Core/Observation/Domain/requestCost';

import { amount, duration, offset, rawDollars } from './format';

/** One categorical color per service. Defined in styles.css. */
const serviceColor = (service: Service) => `var(--service-${service.toLowerCase().replace(/\s+/g, '-')})`;

const percent = (share: number) => {
  if (share > 0 && share < 0.001) return '<0.1%';
  return `${share >= 0.1 ? Math.round(share * 100) : Number((share * 100).toFixed(1))}%`;
};

/** A factor of a term: the value, and what it stands for under it. */
interface Factor {
  readonly value: string;
  readonly symbol: string;
}

/** One line of a sum: its factors multiplied together, its cost, and the color of the one service that bills it. */
interface Term {
  readonly factors: readonly Factor[];
  readonly cost: number;
  readonly color?: string;
  readonly note?: string;
}

const termOf = (line: CostTerm): Term => ({
  factors: [
    { value: amount(line.quantity), symbol: line.item },
    { value: rawDollars(line.unitPrice), symbol: `${line.service} per ${line.unit}` },
  ],
  cost: line.cost,
  color: serviceColor(line.service),
  ...(line.note !== undefined && { note: line.note }),
});

const stageTerm = (stage: StageCost): Term => {
  const [only, ...rest] = splitShares(stage.services);
  return {
    factors: [{ value: exactDollars(stage.cost), symbol: stageLabels[stage.stage].toLowerCase() }],
    cost: stage.cost,
    ...(only !== undefined && rest.length === 0 && { color: serviceColor(only.service) }),
  };
};

const stageEnd: Record<StageName, string> = {
  inbox: 'last inbox run end',
  leadSources: 'last source run end',
  leads: 'last lead run end',
};

/**
 * What one request cost, as the burst simulator shows a burst: a row for each stage and a total, each with its time, its
 * cost, and the share of each service. A click on a row shows how the cost adds up from the quantities in the logs.
 */
export function RequestCostView({
  cost,
  missing,
}: {
  readonly cost: RequestCost;
  /** The stages whose runs did not load. Their cost is not in the total. */
  readonly missing: readonly StageName[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-extrabold tracking-tight">Cost</h3>
        <p className="text-xs text-muted-foreground">
          from the runs in the logs, at the list prices of {prices.region}, without the free tier
        </p>
      </div>
      {(missing.length > 0 || cost.unbilledRuns > 0) && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          {missing.length > 0 &&
            `The runs of ${missing.map((stage) => stageLabels[stage]).join(' and ')} did not load, so the cost leaves them out. `}
          {cost.unbilledRuns > 0 &&
            `${cost.unbilledRuns} ${cost.unbilledRuns === 1 ? 'run has' : 'runs have'} no REPORT line yet, so the cost leaves out their time.`}
        </p>
      )}
      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,2fr)] gap-x-4 border-b px-4 py-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          <span>Step</span>
          <span>Time</span>
          <span>Cost</span>
        </div>
        {cost.stages.map((stage) => (
          <StageRow key={stage.stage} stage={stage} missing={missing.includes(stage.stage)} />
        ))}
        <CostRow
          label="Total"
          open={open}
          onToggle={() => setOpen(!open)}
          total
          time={<TimeCell ms={cost.endMs} formula="last run end" />}
          value={cost.cost}
          services={cost.services}
          terms={cost.stages.filter(({ runs, cost }) => runs > 0 || cost > 0).map(stageTerm)}
        />
      </div>
    </section>
  );
}

function StageRow({ stage, missing }: { readonly stage: StageCost; readonly missing: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <CostRow
      label={stageLabels[stage.stage]}
      hint={missing ? 'not loaded' : `${stage.runs} ${stage.runs === 1 ? 'run' : 'runs'}`}
      open={open}
      onToggle={() => setOpen(!open)}
      time={<TimeCell ms={stage.endMs} formula={stage.runs === 0 ? 'no run' : stageEnd[stage.stage]} />}
      value={stage.cost}
      services={stage.services}
      terms={stage.terms.map(termOf)}
    />
  );
}

function TimeCell({ ms, formula }: { readonly ms: number | undefined; readonly formula: string }) {
  return (
    <span className="flex flex-col gap-1">
      <span className={cn('font-semibold', ms === undefined && 'text-muted-foreground')}>
        {ms === undefined ? '–' : offset(ms)}
      </span>
      <span className="font-mono text-[11px] text-muted-foreground" title={ms === undefined ? undefined : duration(ms)}>
        {formula}
      </span>
    </span>
  );
}

function CostRow({
  label,
  hint,
  open,
  onToggle,
  time,
  value,
  services,
  terms,
  total = false,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly time: ReactNode;
  readonly value: number;
  readonly services: ServiceSplit;
  readonly terms: readonly Term[];
  readonly total?: boolean;
}) {
  return (
    <div
      className={cn(
        'grid grid-cols-[minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,2fr)] gap-x-4 gap-y-3 border-b px-4 py-3 last:border-b-0',
        total ? 'bg-live-soft/40' : 'bg-card'
      )}
    >
      <div className="flex flex-col gap-0.5">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="group flex cursor-pointer items-center gap-1.5 text-left font-bold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight
            className={cn('size-3.5 flex-none transition-transform motion-reduce:transition-none', open && 'rotate-90')}
          />
          {label}
        </button>
        {hint !== undefined && <span className="pl-5 text-xs text-muted-foreground">{hint}</span>}
      </div>
      {time}
      <div className="flex min-w-0 flex-col gap-1.5">
        <CostValue value={value} large={total} />
        <ServiceBar split={services} />
        {open && (
          <div className="mt-2 flex flex-col gap-3">
            <Terms terms={terms} value={value} />
            <ServiceList split={services} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Dims the zeros before the first significant digit of a cost, so the size of a small cost shows at a glance. */
function CostValue({ value, large = false }: { readonly value: number; readonly large?: boolean }) {
  const text = exactDollars(value);
  const [, zeros, digits] = /^(\$0\.0*)(\d.*)$/.exec(text) ?? [text, '', text];
  return (
    <span className={cn('font-mono font-semibold', large ? 'text-lg text-primary' : 'text-sm')}>
      {zeros !== '' && <span className="opacity-45">{zeros}</span>}
      {digits}
    </span>
  );
}

/** The share of each service in one cost, as one stacked bar. */
function ServiceBar({ split }: { readonly split: ServiceSplit }) {
  const parts = splitShares(split);
  if (parts.length === 0) return null;
  return (
    <span className="flex h-1 w-full gap-px overflow-hidden rounded-full" aria-hidden="true">
      {parts.map((part) => (
        <span
          key={part.service}
          className="min-w-1"
          style={{ flexGrow: part.share, background: serviceColor(part.service) }}
          title={`${part.service} ${exactDollars(part.cost)} · ${percent(part.share)}`}
        />
      ))}
    </span>
  );
}

/** The services of one cost with their dollars and share, so a color is never the only label. */
function ServiceList({ split }: { readonly split: ServiceSplit }) {
  const parts = splitShares(split);
  if (parts.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      {parts.map((part) => (
        <li key={part.service} className="grid grid-cols-[10px_1fr_auto_44px] items-center gap-x-2">
          <i className="size-2 rounded-[2px]" style={{ background: serviceColor(part.service) }} />
          <span>{part.service}</span>
          <span className="font-mono font-semibold">{exactDollars(part.cost)}</span>
          <span className="text-right text-muted-foreground">{percent(part.share)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Each value sits above what it stands for, so the sum and its numbers read as one. A term with more than one factor
 * shows its own cost; the last line is the sum. A term whose quantity the logs do not count directly has a note.
 */
function Terms({ terms, value }: { readonly terms: readonly Term[]; readonly value: number }) {
  if (terms.length === 0) return <p className="text-xs text-muted-foreground">No cost.</p>;
  return (
    <ol className="flex flex-col gap-1.5 font-mono text-xs">
      {terms.map((part, index) => (
        <li
          key={index}
          className={cn(
            'grid grid-cols-[14px_1fr_auto] items-start gap-x-2 border-l-2 pl-2',
            part.note !== undefined && 'cursor-help'
          )}
          style={{ borderLeftColor: part.color ?? 'transparent' }}
          title={part.note}
        >
          <span className="text-muted-foreground">{index === 0 ? '' : '+'}</span>
          <span className="flex flex-wrap items-start gap-x-1.5 gap-y-1">
            {part.factors.map((each, position) => (
              <span key={position} className="flex items-start gap-1.5">
                {position > 0 && <span className="text-muted-foreground">×</span>}
                <span className="flex flex-col">
                  <span>{each.value}</span>
                  <span className="font-sans text-[11px] text-muted-foreground">
                    {each.symbol}
                    {position === 0 && part.note !== undefined && <sup aria-label={part.note}> ⓘ</sup>}
                  </span>
                </span>
              </span>
            ))}
          </span>
          {part.factors.length > 1 && <span className="text-muted-foreground">{exactDollars(part.cost)}</span>}
        </li>
      ))}
      <li className="grid grid-cols-[14px_1fr_auto] gap-x-2 border-t pt-1.5 pl-2.5 font-semibold">
        <span className="text-muted-foreground">=</span>
        <span>{exactDollars(value)}</span>
      </li>
    </ol>
  );
}

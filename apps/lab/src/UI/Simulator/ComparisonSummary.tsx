import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { ComparisonNote, RequestRead } from '#Core/Observation/Domain/comparison';
import type {
  ComparisonSummary,
  Measure,
  MeasureValue,
  StageMeasures,
  StatName,
} from '#Core/Observation/Domain/comparisonSummary';
import { laneNames } from '#Core/Simulation/Domain/lane';

import { laneLabels, multiple, Pair, verdictClass } from './Comparison';
import { duration, number, rate } from './format';

/** What a cell shows: a value over all the requests, or the value of each request. */
type View = 'median' | 'mean' | 'each';

const viewLabels: Record<View, string> = { median: 'med', mean: 'avg', each: 'each' };
const viewTitles: Record<View, string> = {
  median: 'The median of the requests',
  mean: 'The mean of the requests',
  each: 'The value of each request',
};

type Format = (value: number) => string;

const count: Format = (value) => value.toLocaleString('en-US', { maximumFractionDigits: 2 });
/** A mean has no end of digits, so a time keeps the 2 decimals of a REPORT line. */
const clock: Format = (ms) => duration(Math.round(ms * 100) / 100);

const shown = (format: Format, value: number | undefined) => (value === undefined ? '—' : format(value));
const ratioText = (ratio: number | undefined) => (ratio === undefined ? undefined : multiple(ratio));

/** A place in the list of the person, from 1. The tables name a request by its place, because an ID does not fit. */
const placesOf = (reads: readonly RequestRead[]) =>
  new Map(reads.map(({ requestID }, index) => [requestID, index + 1]));

function ViewSwitch({
  views,
  view,
  name,
  onView,
}: {
  readonly views: readonly View[];
  /** No view when the cells of a column show different views. */
  readonly view: View | undefined;
  readonly name: string;
  readonly onView: (view: View) => void;
}) {
  if (views.length < 2) return null;
  return (
    <fieldset className="compare-switch" aria-label={`How to show ${name}`}>
      {views.map((each) => (
        <button
          key={each}
          type="button"
          aria-pressed={view === each}
          title={viewTitles[each]}
          onClick={() => onView(each)}
        >
          {viewLabels[each]}
        </button>
      ))}
    </fieldset>
  );
}

const allViews: readonly View[] = ['median', 'mean', 'each'];

/** Without a counted request, the summary has no median, so a cell can show only each request. */
const viewsOf = (measure: Measure) => (measure.real === undefined ? (['each'] as const) : allViews);

/** One cell of a table that has a switch. */
interface Cell {
  readonly key: string;
  readonly measure: Measure;
}

/** The view of each cell of a table. A column switch sets all the cells of its column, a cell switch only its own. */
function useCellViews(start: View) {
  const [picked, setPicked] = useState<Readonly<Record<string, View>>>({});
  return {
    viewOf: ({ key, measure }: Cell): View => (measure.real === undefined ? 'each' : (picked[key] ?? start)),
    setViews: (keys: readonly string[], view: View) =>
      setPicked((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, view])) })),
  };
}

/**
 * The switch in the head of a column. It shows a view only while all the cells show that view. A cell without a switch
 * has no part in it, so a column without such cells has no switch.
 */
function ColumnSwitch({
  cells,
  name,
  viewOf,
  onViews,
}: {
  readonly cells: readonly Cell[];
  readonly name: string;
  readonly viewOf: (cell: Cell) => View;
  readonly onViews: (keys: readonly string[], view: View) => void;
}) {
  const open = cells.filter(({ measure }) => !measure.same && measure.real !== undefined);
  const [first] = open;
  if (first === undefined) return null;
  const same = open.every((cell) => viewOf(cell) === viewOf(first));
  return (
    <ViewSwitch
      views={allViews}
      view={same ? viewOf(first) : undefined}
      name={name}
      onView={(view) =>
        onViews(
          open.map(({ key }) => key),
          view
        )
      }
    />
  );
}

function Range({ measure, format }: { readonly measure: Measure; readonly format: Format }) {
  const { real } = measure;
  if (real === undefined || real.min === real.max) return null;
  return (
    <span className="compare-range">
      {format(real.min)} to {format(real.max)}
    </span>
  );
}

const titleOf = ({ requestID, model, counted }: MeasureValue, format: Format) =>
  `${requestID} · model ${shown(format, model)}${counted ? '' : ' · not in the summary'}`;

/** The model values of the requests differ only when the requests have different shapes. */
const modelsDiffer = ({ values }: Measure) => values.some(({ model }) => model !== values[0]?.model);

/** One line for each request. A line names the model only when the models of the requests differ. */
function EachRequest({
  measure,
  format,
  places,
}: {
  readonly measure: Measure;
  readonly format: Format;
  readonly places: ReadonlyMap<string, number>;
}) {
  const differ = modelsDiffer(measure);
  return (
    <>
      {differ ? null : <span className="compare-model">model {shown(format, measure.values[0]?.model)}</span>}
      <ol className="compare-each">
        {measure.values.map((value) => (
          <li
            key={value.requestID}
            className={value.counted ? undefined : 'compare-each-out'}
            title={titleOf(value, format)}
          >
            <span className="compare-place">#{places.get(value.requestID)}</span>
            <span className={`compare-each-real ${verdictClass(value.real, value.model) ?? ''}`}>
              {shown(format, value.real)}
            </span>
            {differ ? <span className="compare-each-model">model {shown(format, value.model)}</span> : null}
            {value.ratio === undefined ? null : <b>{multiple(value.ratio)}</b>}
          </li>
        ))}
      </ol>
    </>
  );
}

/**
 * One measure in the stage table. A measure that is the same in each request shows one plain value and no switch.
 * Otherwise the cell has its own switch: the median, the mean, or the value of each request.
 */
function MeasureCell({
  measure,
  view,
  name,
  format,
  places,
  onView,
}: {
  readonly measure: Measure;
  readonly view: View;
  readonly name: string;
  readonly format: Format;
  readonly places: ReadonlyMap<string, number>;
  readonly onView: (view: View) => void;
}) {
  const first = measure.values[0];
  if (measure.same) {
    return (
      <Pair
        real={shown(format, first?.real)}
        model={shown(format, first?.model)}
        change={ratioText(first?.ratio)}
        tone={verdictClass(first?.real, first?.model)}
      />
    );
  }
  return (
    <td className="compare-measure">
      <div className="compare-measure-head">
        {view === 'each' ? (
          <span />
        ) : (
          <span className={`compare-real ${verdictClass(measure.real?.[view], measure.model?.[view]) ?? ''}`}>
            {shown(format, measure.real?.[view])}
          </span>
        )}
        <ViewSwitch views={viewsOf(measure)} view={view} name={name} onView={onView} />
      </div>
      {view === 'each' ? (
        <EachRequest measure={measure} format={format} places={places} />
      ) : (
        <>
          <span className="compare-model">
            model {shown(format, measure.model?.[view])}
            {measure.ratio === undefined ? null : <b>{multiple(measure.ratio[view])}</b>}
          </span>
          <Range measure={measure} format={format} />
        </>
      )}
    </td>
  );
}

const stageColumns: readonly {
  readonly stat: StatName;
  readonly label: string;
  readonly name: string;
  readonly format: Format;
}[] = [
  { stat: 'handlers', label: 'Handlers', name: 'the handlers', format: count },
  { stat: 'coldStarts', label: 'Cold starts', name: 'the cold starts', format: count },
  { stat: 'firstStart', label: 'First start', name: 'the first start', format: clock },
  { stat: 'lastEnd', label: 'Last end', name: 'the last end', format: clock },
  { stat: 'meanDuration', label: 'Mean handler time', name: 'the mean handler time', format: clock },
];

/** The stages over all the requests. A cell picks its own view, and the head of a column picks it for all its cells. */
export function SummaryStages({
  summary,
  reads,
}: {
  readonly summary: ComparisonSummary;
  readonly reads: readonly RequestRead[];
}) {
  const places = placesOf(reads);
  const { viewOf, setViews } = useCellViews('median');
  const rows: readonly { readonly key: string; readonly label: string; readonly measures: StageMeasures }[] = [
    ...laneNames.map((lane) => ({ key: lane, label: laneLabels[lane], measures: summary.stages[lane] })),
    { key: 'whole', label: 'Whole request', measures: summary.whole },
  ];
  const cellOf = (row: (typeof rows)[number], stat: StatName): Cell => ({
    key: `${row.key}:${stat}`,
    measure: row.measures[stat],
  });
  return (
    <table className="compare-table">
      <caption>
        Times are on one clock from the time S3 stored each email. A ratio compares each request with the model of its
        own shape, and the cell shows the median or the mean of those ratios. A green real value is lower than the
        model, and a red one is higher. The switch in the head of a column sets all its cells. A cell without a switch
        has the same value in each request. The range is the lowest and the highest real value.
      </caption>
      <thead>
        <tr>
          <th>Stage</th>
          {stageColumns.map(({ stat, label, name }) => (
            <th key={stat}>
              <div className="compare-row-head">
                <span>{label}</span>
                <ColumnSwitch
                  cells={rows.map((row) => cellOf(row, stat))}
                  name={`all of ${name}`}
                  viewOf={viewOf}
                  onViews={setViews}
                />
              </div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} className={row.key === 'whole' ? 'compare-total' : undefined}>
            <th>{row.label}</th>
            {stageColumns.map(({ stat, name, format }) => {
              const cell = cellOf(row, stat);
              return (
                <MeasureCell
                  key={stat}
                  measure={cell.measure}
                  view={viewOf(cell)}
                  name={`${name} of ${row.label.toLowerCase()}`}
                  format={format}
                  places={places}
                  onView={(view) => setViews([cell.key], view)}
                />
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** One line of the cost table. Its three values read together, so one switch in the head of the row sets them all. */
function CostRow({
  label,
  measure,
  view,
  places,
  className,
  swatch,
  onView,
}: {
  readonly label: string;
  readonly measure: Measure;
  readonly view: View;
  readonly places: ReadonlyMap<string, number>;
  readonly className?: string | undefined;
  readonly swatch?: string | undefined;
  readonly onView: (view: View) => void;
}) {
  const list = (text: (value: MeasureValue) => string, tone?: (value: MeasureValue) => string | undefined) => (
    <ol className="compare-each">
      {measure.values.map((value) => (
        <li
          key={value.requestID}
          className={value.counted ? undefined : 'compare-each-out'}
          title={titleOf(value, rate)}
        >
          <span className="compare-place">#{places.get(value.requestID)}</span>
          <span className={tone?.(value)}>{text(value)}</span>
        </li>
      ))}
    </ol>
  );
  const first = measure.values[0];
  const each = view === 'each' && !measure.same;
  const ratioOf = (value: MeasureValue) => ratioText(value.ratio) ?? 'not in the model';
  const summed = (spread: Measure['real']) => (view === 'each' || spread === undefined ? undefined : spread[view]);
  const realCost = measure.same ? first?.real : summed(measure.real);
  const modelCost = measure.same ? first?.model : summed(measure.model);
  return (
    <tr className={className}>
      <th>
        <div className="compare-row-head">
          <span className="compare-row-name">
            {swatch === undefined ? null : <i style={{ background: swatch }} />}
            {label}
          </span>
          {measure.same ? null : (
            <ViewSwitch
              views={viewsOf(measure)}
              view={view}
              name={`the cost of ${label.toLowerCase()}`}
              onView={onView}
            />
          )}
        </div>
      </th>
      <td className="compare-number">
        {each && modelsDiffer(measure)
          ? list(({ model }) => shown(rate, model))
          : shown(rate, measure.same || view === 'each' ? first?.model : summed(measure.model))}
      </td>
      <td className="compare-number">
        {each ? (
          list(
            ({ real }) => shown(rate, real),
            ({ real, model }) => verdictClass(real, model)
          )
        ) : (
          <>
            <span className={verdictClass(realCost, modelCost)}>{shown(rate, realCost)}</span>
            {measure.same ? null : <Range measure={measure} format={rate} />}
          </>
        )}
      </td>
      <td className="compare-number">
        {each ? list(ratioOf) : (ratioText(measure.same ? first?.ratio : summed(measure.ratio)) ?? 'not in the model')}
      </td>
    </tr>
  );
}

/** The cost over all the requests. A cost adds up, so its rows start with the mean. */
export function SummaryCost({
  summary,
  reads,
}: {
  readonly summary: ComparisonSummary;
  readonly reads: readonly RequestRead[];
}) {
  const places = placesOf(reads);
  const { viewOf, setViews } = useCellViews('mean');
  const rows: readonly (Cell & { readonly className?: string; readonly swatch?: string })[] = [
    ...laneNames.map((lane) => ({ key: laneLabels[lane], measure: summary.cost.stages[lane] })),
    { key: 'Total', measure: summary.cost.total, className: 'compare-total' },
    ...summary.cost.services.map(({ service, measure }) => ({
      key: service,
      measure,
      className: 'compare-service-row',
      swatch: `var(--service-${service.toLowerCase().replace(/\s+/g, '-')})`,
    })),
  ];
  return (
    <table className="compare-table compare-cost">
      <caption>
        The model is the applied price of the burst of each shape, one email with its cold starts. The real cost comes
        from the runs in the logs, at the same prices. A green real cost is lower than the model, and a red one is
        higher. The switch of a row sets all its values, and the switch in the head of the table sets all the rows. The
        model does not price the S3 storage of the email and the sources between their store and their delete.
      </caption>
      <thead>
        <tr>
          <th>
            <div className="compare-row-head">
              <span>Cost</span>
              <ColumnSwitch cells={rows} name="all the costs" viewOf={viewOf} onViews={setViews} />
            </div>
          </th>
          <th>Model</th>
          <th>Real</th>
          <th>Real ÷ model</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <CostRow
            key={row.key}
            label={row.key}
            measure={row.measure}
            view={viewOf(row)}
            places={places}
            className={row.className}
            swatch={row.swatch}
            onView={(view) => setViews([row.key], view)}
          />
        ))}
      </tbody>
    </table>
  );
}

const plural = (amount: number, one: string, many = `${one}s`) => `${number(amount)} ${amount === 1 ? one : many}`;

/** The four facts that decide how far the numbers of the tables can go. */
export function SummaryFacts({ summary }: { readonly summary: ComparisonSummary }) {
  const { requests, counted, shapes, coldRequests, sharedRuns } = summary;
  return (
    <ul className="compare-facts">
      <li>
        <b>{number(counted)}</b> of {number(requests.length)} requests in the summary
      </li>
      <li>
        <b>{number(shapes)}</b> {shapes === 1 ? 'shape' : 'shapes'}
      </li>
      <li>
        <b>{number(coldRequests)}</b> with cold starts
      </li>
      <li>
        <b>{number(sharedRuns)}</b> shared lead {sharedRuns === 1 ? 'run' : 'runs'}
      </li>
    </ul>
  );
}

/** What the summary cannot show, so that a difference is not read as an error of the model. */
export function summaryNotes(summary: ComparisonSummary, reads: readonly RequestRead[]): ComparisonNote[] {
  const places = placesOf(reads);
  const { counted, shapes, coldRequests, sharedRuns } = summary;
  const notes = summary.requests.flatMap(({ requestID, gap }): ComparisonNote[] =>
    gap === undefined ? [] : [{ kind: 'limit', text: `#${places.get(requestID)} is not in the summary. ${gap}` }]
  );
  const warm = counted - coldRequests;
  if (warm > 0) {
    notes.push({
      kind: 'limit',
      text: `${plural(warm, 'request')} had no cold start, but the model of a burst starts cold. ${warm === 1 ? 'It differs' : 'They differ'} from the model for that reason too.`,
    });
  }
  if (sharedRuns > 0) {
    notes.push({
      kind: 'limit',
      text: `${plural(sharedRuns, 'lead run')} also took the leads of other requests. The handler times and the last ends use the whole run, so these requests are not independent. The real cost counts only the share of each request.`,
    });
  }
  if (shapes > 1) {
    notes.push({
      kind: 'estimate',
      text: `The requests have ${number(shapes)} shapes, because ${summary.shapeKeys.join(', ')} ${summary.shapeKeys.length === 1 ? 'differs' : 'differ'}. Each shape has its own model, and a model value is the median or the mean of those models.`,
    });
  }
  return notes;
}

/**
 * The status, the request row, and the facts. The bar floats under the header of the app until the page ends, and it
 * goes back to its place when the person scrolls back. The sticky parts of the timeline must sit under it, so the bar
 * gives them its height. In a narrow window the bar does not float, because it takes too much of the screen.
 */
export function ComparisonBar({ children }: { readonly children: ReactNode }) {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = bar.current;
    const page = node?.closest<HTMLElement>('.simulator');
    if (!node || !page) return;
    const measure = () => {
      if (getComputedStyle(node).position === 'sticky') page.style.setProperty('--sim-float', `${node.offsetHeight}px`);
      else page.style.removeProperty('--sim-float');
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => {
      observer.disconnect();
      page.style.removeProperty('--sim-float');
    };
  }, []);
  return (
    <div ref={bar} className="compare-bar">
      <div className="compare-bar-body">{children}</div>
    </div>
  );
}

/**
 * The row that picks the requests to show: all of them in the summary, or one of them in the full tables. The knobs and
 * the timeline always follow one request, because a median request has no runs to draw.
 */
export function RequestPicker({
  reads,
  summary,
  allShown,
  shown: focus,
  onAll,
  onRequest,
}: {
  readonly reads: readonly RequestRead[];
  readonly summary: ComparisonSummary | null;
  readonly allShown: boolean;
  /** The request that sets the knobs and draws the timeline. */
  readonly shown: string | undefined;
  readonly onAll: () => void;
  readonly onRequest: (requestID: string) => void;
}) {
  const places = placesOf(reads);
  const all = summary !== null && allShown;
  const gaps = new Map(summary?.requests.map(({ requestID, gap }) => [requestID, gap]));
  return (
    <div className="compare-pick">
      <fieldset className="compare-pick-row" aria-label="The requests that the tables show">
        {summary === null ? null : (
          <button type="button" aria-pressed={all} onClick={onAll}>
            All requests
          </button>
        )}
        {reads.map(({ requestID, result }) => {
          const gap = gaps.get(requestID);
          const title = result.ok
            ? `${requestID} · ${result.entry.state}${gap === undefined ? '' : ` · not in the summary: ${gap}`}`
            : `${requestID} · ${result.error}`;
          return (
            <button
              key={requestID}
              type="button"
              className={gap === undefined && result.ok ? undefined : 'compare-pick-gap'}
              aria-pressed={!all && requestID === focus}
              disabled={!result.ok}
              title={title}
              onClick={() => onRequest(requestID)}
            >
              <b>#{places.get(requestID)}</b>
              <code>{requestID.slice(0, 8)}</code>
            </button>
          );
        })}
      </fieldset>
      {all && focus !== undefined ? (
        <p>The knobs and the timeline show #{places.get(focus)}. Pick a request to see its full tables.</p>
      ) : null}
    </div>
  );
}

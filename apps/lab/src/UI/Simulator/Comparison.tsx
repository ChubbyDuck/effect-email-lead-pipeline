import { services } from '@leads/shared/domain/billing';
import { useState } from 'react';

import {
  type Comparison,
  comparisonLimit,
  type ComparisonNote,
  laneStages,
  requestIDsOf,
  type RequestRead,
  statsOf,
  verdictOf,
  wholeOf,
} from '#Core/Observation/Domain/comparison';
import type { RequestCost } from '#Core/Observation/Domain/requestCost';
import type { Charges } from '#Core/Simulation/Domain/charges';
import { type Lane, type LaneName, laneNames } from '#Core/Simulation/Domain/lane';

import { duration, number, rate } from './format';

/** What the page knows about the requests that it compares. */
export type ComparisonState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading'; readonly requestIDs: readonly string[] }
  | { readonly kind: 'ready'; readonly reads: readonly RequestRead[] };

export const laneLabels: Record<LaneName, string> = { inbox: 'Inbox', sources: 'Sources', leads: 'Leads' };

/** A difference of two times, with its sign. */
const delta = (real: number, model: number) => {
  const difference = real - model;
  if (Math.abs(difference) < 0.5) return 'same';
  return `${difference > 0 ? '+' : '−'}${duration(Math.abs(difference))}`;
};

export const multiple = (ratio: number) => `×${ratio.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** How many times the model the real value is. */
const times = (real: number, model: number) => {
  if (model === 0) return real === 0 ? 'same' : 'not in the model';
  return multiple(real / model);
};

const time = (ms: number | undefined) => (ms === undefined ? '—' : duration(ms));

/** The line under the field: what the page reads, or what it read. */
export function ReadStatus({ state }: { readonly state: ComparisonState }) {
  if (state.kind === 'none') {
    return (
      <output className="compare-status compare-status-none">
        Read real requests from the logs and draw them with the model. Each request sets E, S, L, and row_b for its own
        model. The other knobs stay yours.
      </output>
    );
  }
  if (state.kind === 'loading') {
    const [first] = state.requestIDs;
    return (
      <output className="compare-status compare-status-loading">
        {state.requestIDs.length === 1
          ? `Reading the ledger entry and the logs of ${first}…`
          : `Reading the ledger entries and the logs of ${state.requestIDs.length} requests…`}
      </output>
    );
  }
  const { reads } = state;
  const [only] = reads;
  if (reads.length === 1 && only !== undefined) {
    return only.result.ok ? (
      <output className="compare-status compare-status-ready">
        {`${only.requestID} · ${only.result.entry.state}${only.result.entry.receivedAt === undefined ? '' : ` · received ${new Date(only.result.entry.receivedAt).toLocaleString('en-GB')}`}`}
      </output>
    ) : (
      <output className="compare-status compare-status-error">{only.result.error}</output>
    );
  }
  const failed = reads.flatMap((read, index) => (read.result.ok ? [] : [{ place: index + 1, ...read.result }]));
  return (
    <>
      <output className="compare-status compare-status-ready">
        {`${number(reads.length - failed.length)} of ${number(reads.length)} requests read`}
      </output>
      {failed.map(({ place, error }) => (
        <p key={place} className="compare-status compare-status-error">
          #{place}: {error}
        </p>
      ))}
    </>
  );
}

/** The field for the request IDs. Enter reads the requests, and Shift+Enter starts a new line. */
export function RequestField({
  requests,
  state,
  onRequests,
}: {
  readonly requests: readonly string[];
  readonly state: ComparisonState;
  readonly onRequests: (requestIDs: readonly string[]) => void;
}) {
  const [tooMany, setTooMany] = useState<number>();
  return (
    <div className="compare-field">
      <form
        className="compare-form"
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get('requests');
          const requestIDs = requestIDsOf(typeof value === 'string' ? value : '');
          if (requestIDs.length > comparisonLimit) {
            setTooMany(requestIDs.length);
            return;
          }
          setTooMany(undefined);
          onRequests(requestIDs);
        }}
      >
        <label>
          <span>Request IDs</span>
          {/* The key resets the field when the requests change from outside, such as a link. */}
          <textarea
            key={requests.join(',')}
            name="requests"
            rows={1}
            defaultValue={requests.join('\n')}
            placeholder={`Paste the SES message IDs of 1 to ${comparisonLimit} emails`}
            autoComplete="off"
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return;
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
        </label>
        <button type="submit" disabled={state.kind === 'loading'}>
          {state.kind === 'loading' ? 'Reading…' : 'Compare'}
        </button>
        {requests.length === 0 ? null : (
          <button
            type="button"
            onClick={() => {
              setTooMany(undefined);
              onRequests([]);
            }}
          >
            Clear
          </button>
        )}
      </form>
      {tooMany !== undefined ? (
        <output className="compare-status compare-status-error">
          Paste at most {comparisonLimit} request IDs. This text has {tooMany}.
        </output>
      ) : state.kind === 'ready' && state.reads.length > 1 ? null : (
        <ReadStatus state={state} />
      )}
    </div>
  );
}

/** The color of a real value next to its model: green when it is better, red when it is worse. */
export const verdictClass = (real: number | undefined, model: number | undefined) => {
  const verdict = verdictOf(real, model);
  return verdict === undefined ? undefined : `compare-${verdict}`;
};

/** One cell: the real value first, the model value under it. */
export function Pair({
  real,
  model,
  change,
  tone,
}: {
  real: string;
  model: string;
  change?: string | undefined;
  tone?: string | undefined;
}) {
  return (
    <td>
      <span className={`compare-real ${tone ?? 'compare-none'}`}>{real}</span>
      <span className="compare-model">
        model {model}
        {change === undefined || change === 'same' ? null : <b>{change}</b>}
      </span>
    </td>
  );
}

/** The stages of the model and of the real request, read the same way. */
export function StageComparison({ comparison, model }: { comparison: Comparison; model: Record<LaneName, Lane> }) {
  const rows = laneNames.map((lane) => ({
    lane,
    real: statsOf(comparison.lanes[lane].pool),
    model: statsOf(model[lane].pool),
  }));
  const realWhole = wholeOf(rows.map((row) => row.real));
  const modelWhole = wholeOf(rows.map((row) => row.model));
  return (
    <table className="compare-table">
      <caption>
        Times are on one clock from the time S3 stored the email. A handler time leaves out INIT. The model runs the
        shape of the request with your timing knobs. A green real value is lower than the model, and a red one is
        higher.
      </caption>
      <thead>
        <tr>
          <th>Stage</th>
          <th>Handlers</th>
          <th>Cold starts</th>
          <th>First start</th>
          <th>Last end</th>
          <th>Mean handler time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ lane, real, model: predicted }) => (
          <tr key={lane}>
            <th>{laneLabels[lane]}</th>
            <Pair
              real={number(real.handlers)}
              model={number(predicted.handlers)}
              tone={verdictClass(real.handlers, predicted.handlers)}
            />
            <Pair
              real={number(real.coldStarts)}
              model={number(predicted.coldStarts)}
              tone={verdictClass(real.coldStarts, predicted.coldStarts)}
            />
            <Pair
              real={time(real.firstStart)}
              model={time(predicted.firstStart)}
              tone={verdictClass(real.firstStart, predicted.firstStart)}
              {...(real.firstStart !== undefined &&
                predicted.firstStart !== undefined && { change: delta(real.firstStart, predicted.firstStart) })}
            />
            <Pair
              real={time(real.lastEnd)}
              model={time(predicted.lastEnd)}
              tone={verdictClass(real.lastEnd, predicted.lastEnd)}
              {...(real.lastEnd !== undefined &&
                predicted.lastEnd !== undefined && { change: delta(real.lastEnd, predicted.lastEnd) })}
            />
            <Pair
              real={time(real.meanDuration)}
              model={time(predicted.meanDuration)}
              tone={verdictClass(real.meanDuration, predicted.meanDuration)}
              {...(real.meanDuration !== undefined &&
                predicted.meanDuration !== undefined && { change: times(real.meanDuration, predicted.meanDuration) })}
            />
          </tr>
        ))}
        <tr className="compare-total">
          <th>Whole request</th>
          <Pair
            real={number(realWhole.handlers)}
            model={number(modelWhole.handlers)}
            tone={verdictClass(realWhole.handlers, modelWhole.handlers)}
          />
          <Pair
            real={number(realWhole.coldStarts)}
            model={number(modelWhole.coldStarts)}
            tone={verdictClass(realWhole.coldStarts, modelWhole.coldStarts)}
          />
          <Pair
            real={time(realWhole.firstStart)}
            model={time(modelWhole.firstStart)}
            tone={verdictClass(realWhole.firstStart, modelWhole.firstStart)}
          />
          <Pair
            real={time(realWhole.lastEnd)}
            model={time(modelWhole.lastEnd)}
            tone={verdictClass(realWhole.lastEnd, modelWhole.lastEnd)}
            {...(realWhole.lastEnd !== undefined &&
              modelWhole.lastEnd !== undefined && { change: delta(realWhole.lastEnd, modelWhole.lastEnd) })}
          />
          <Pair real="—" model="—" />
        </tr>
      </tbody>
    </table>
  );
}

/** The cost of the model next to the cost from the logs, for each stage and for each service. */
export function CostComparison({ burst, real }: { burst: Charges; real: RequestCost }) {
  const stages = laneNames.map((lane, index) => {
    const line = burst.lines[index];
    const stage = real.stages.find((each) => each.stage === laneStages[lane]);
    return { lane, model: line?.applied.value ?? 0, real: stage?.cost ?? 0 };
  });
  const shown = services.filter(
    (service) => (burst.applied.services[service] ?? 0) > 0 || (real.services[service] ?? 0) > 0
  );
  return (
    <table className="compare-table compare-cost">
      <caption>
        The model is the applied price of the burst, one email with its cold starts. The real cost comes from the runs
        in the logs, as the lab prices them, at the same prices. A green real cost is lower than the model, and a red
        one is higher.
        {real.unbilledRuns > 0
          ? ` ${number(real.unbilledRuns)} ${real.unbilledRuns === 1 ? 'run has' : 'runs have'} no REPORT line, so the real cost leaves ${real.unbilledRuns === 1 ? 'its' : 'their'} time out.`
          : ''}{' '}
        The model does not price the S3 storage of the email and the sources between their store and their delete.
      </caption>
      <thead>
        <tr>
          <th>Cost</th>
          <th>Model</th>
          <th>Real</th>
          <th>Real ÷ model</th>
        </tr>
      </thead>
      <tbody>
        {stages.map((stage) => (
          <tr key={stage.lane}>
            <th>{laneLabels[stage.lane]}</th>
            <td className="compare-number">{rate(stage.model)}</td>
            <td className={`compare-number ${verdictClass(stage.real, stage.model) ?? ''}`}>{rate(stage.real)}</td>
            <td className="compare-number">{times(stage.real, stage.model)}</td>
          </tr>
        ))}
        <tr className="compare-total">
          <th>Total</th>
          <td className="compare-number">{rate(burst.applied.value)}</td>
          <td className={`compare-number ${verdictClass(real.cost, burst.applied.value) ?? ''}`}>{rate(real.cost)}</td>
          <td className="compare-number">{times(real.cost, burst.applied.value)}</td>
        </tr>
        {shown.map((service) => {
          const model = burst.applied.services[service] ?? 0;
          const cost = real.services[service] ?? 0;
          return (
            <tr key={service} className="compare-service">
              <th>
                <i style={{ background: `var(--service-${service.toLowerCase().replace(/\s+/g, '-')})` }} />
                {service}
              </th>
              <td className="compare-number">{rate(model)}</td>
              <td className={`compare-number ${verdictClass(cost, model) ?? ''}`}>{rate(cost)}</td>
              <td className="compare-number">{times(cost, model)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const noteTitles: Record<ComparisonNote['kind'], string> = {
  error: 'Missing',
  limit: 'Limit',
  estimate: 'Estimate',
};

/** What the comparison cannot show, so that a difference is not read as an error of the model. */
export function ComparisonNotes({ notes }: { notes: readonly ComparisonNote[] }) {
  return (
    <ul className="compare-notes">
      {notes.map((note) => (
        <li key={note.text} className={`compare-note compare-note-${note.kind}`}>
          <span>{noteTitles[note.kind]}</span>
          {note.text}
        </li>
      ))}
    </ul>
  );
}

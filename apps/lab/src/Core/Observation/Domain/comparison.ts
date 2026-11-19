import type { RequestProgress } from '@leads/shared/domain/request';
import { type StageName, stageLabels, stageNames } from '@leads/shared/domain/stages';

/**
 * A comparison: the simulation of one request next to its real runs, on one clock. The clock starts when S3 stored the
 * email, as the simulation starts when the burst arrives. The request sets the shape of the simulation: one email,
 * its sources, and their leads. The timing knobs stay as the person set them, so the two drawings differ only where
 * the model and the logs differ.
 *
 * The logs give the start, the end, and the INIT of each run, and the time of each progress line and size line. The
 * lines cut each real run into phases. The logs do not show when a message arrives in a queue, so the real queue
 * depth spreads the puts and the sends of a run over the time between two of its lines.
 */
import { laneNames, laneOf, type Lane, type LaneName, type Piece } from '#Core/Simulation/Domain/lane';
import {
  poolOf,
  type HandlerWave,
  type LeadArrival,
  type PoolRun,
  type SourceArrival,
} from '#Core/Simulation/Domain/schedule';
import { leadBatchSize, type SliceInputs } from '#Core/Simulation/Domain/sources';
import type { OutputStretch } from '#Core/Simulation/Domain/swarm';

import type { RequestView } from './requests';
import { type HandlerRun, type RequestRuns, runLineLimit } from './runs';
import { filesOf, type RunTrail, runTrailOf } from './trail';

/** The entry and the runs of one request, or why the read failed. */
export type ComparisonResult =
  | { readonly ok: true; readonly entry: RequestView; readonly runs: RequestRuns }
  | { readonly ok: false; readonly error: string };

/** One request of a list and what its read gave. A failed read does not stop the other reads of the list. */
export interface RequestRead {
  readonly requestID: string;
  readonly result: ComparisonResult;
}

/** The most requests that one comparison reads. Each read does at least two log searches for each stage. */
export const comparisonLimit = 10;

/** The request IDs in a pasted text, once each, in their order. Spaces, new lines, and commas separate them. */
export const requestIDsOf = (text: string): string[] => [...new Set(text.split(/[\s,]+/).filter((id) => id !== ''))];

/** The knobs that a request sets. The other knobs stay as the person set them. */
export const shapeKeys = ['E', 'S', 'L', 'row_b'] as const;
export type ShapeKey = (typeof shapeKeys)[number];
export type RequestShape = Pick<SliceInputs, ShapeKey>;

/** The runs of one stage that the read gave. */
export interface LoadedStage {
  readonly stage: StageName;
  readonly runs: readonly HandlerRun[];
}

/** The stage of the lab that each lane of the simulator shows. */
export const laneStages: Record<LaneName, StageName> = { inbox: 'inbox', sources: 'leadSources', leads: 'leads' };

/** One real run as a wave of one handler, with the ranges between its lines, in ms from the start of its wave. */
interface RealRun {
  readonly run: HandlerRun;
  readonly wave: HandlerWave;
  /** INIT first, when the run had a cold start. */
  readonly pieces: readonly Piece[];
}

/** A limit of the comparison that the page must show. */
export interface ComparisonNote {
  /** `error`: a part of the request is missing. `limit`: the logs give less than the model. `estimate`: a guess. */
  readonly kind: 'error' | 'limit' | 'estimate';
  readonly text: string;
}

export interface Comparison {
  readonly requestID: string;
  readonly shape: RequestShape;
  /** The leads that each source run counted, one value for each source. */
  readonly leadsBySource: readonly number[];
  /** The real runs on the clock of the simulation, one lane for each stage. The releases are estimates. */
  readonly lanes: Readonly<Record<LaneName, Lane>>;
  /** The runs of each stage, as the cost of the request needs them. */
  readonly loaded: readonly LoadedStage[];
  /** In ms since the epoch: 0 on the clock. */
  readonly origin: number;
  readonly notes: readonly ComparisonNote[];
}

const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const plural = (count: number, one: string, many = `${one}s`) =>
  `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** The stages that the read gave, in the order of the pipeline. */
export const loadedOf = (runs: RequestRuns): LoadedStage[] =>
  stageNames.flatMap((stage) => {
    const section = runs.stages[stage];
    return section.ok ? [{ stage, runs: section.value.runs }] : [];
  });

const runsOf = (loaded: readonly LoadedStage[], stage: StageName) =>
  loaded.find((each) => each.stage === stage)?.runs ?? [];

/** The time of the first change of the request in a run that passes `test`, in ms since the epoch. */
const changeAt = (trail: RunTrail, test: (change: RequestProgress) => boolean) =>
  trail.changes.find(({ change }) => test(change))?.at;

/** The read of a kind of file in a run. */
const readOf = (trail: RunTrail, kind: 'email' | 'source') => trail.reads.find(({ size }) => size.kind === kind);

/**
 * The shape that the request gives the simulation: one email, its sources, the mean leads of a source, and the mean
 * bytes of a row. A row size needs a source with leads and a size line. Without one, `row_b` stays as `input` has it.
 */
export function shapeOf(entry: RequestView, loaded: readonly LoadedStage[], input: SliceInputs) {
  const sources = filesOf(runsOf(loaded, 'leadSources'), entry.requestID).filter(({ kind }) => kind === 'source');
  const S = entry.attachments ?? (sources.length > 0 ? sources.length : input.S);
  const leadsBySource = sources.map(({ leads }) => leads);
  const L = sources.length > 0 ? Math.round(mean(leadsBySource)) : S > 0 ? Math.round(entry.sourcesLeads / S) : input.L;
  const rows = sources.flatMap(({ leads, bytes }) => (leads === 0 ? [] : [bytes / leads]));
  const row_b = rows.length > 0 ? Math.round(mean(rows)) : input.row_b;
  return { shape: { E: 1, S, L, row_b } satisfies RequestShape, leadsBySource, measuredRow: rows.length > 0 };
}

interface Mark {
  /** In ms since the epoch, or undefined when the run has no such line. */
  readonly at: number | undefined;
  readonly piece: Omit<Piece, 'start' | 'end'>;
}

/**
 * The ranges of one run from its marks. Each range ends at its mark. A mark that the run does not have joins its range
 * to the next. The tail runs from the last mark to the end of the run. INIT comes first, before the handler code.
 */
function piecesOf(run: HandlerRun, marks: readonly Mark[], tail: Mark['piece'], duration: number): Piece[] {
  const started = Date.parse(run.startedAt);
  const init = run.initMs ?? 0;
  const pieces: Piece[] = [];
  if (init > 0) {
    pieces.push({
      tone: 'init',
      symbol: 'INIT',
      name: 'Cold start',
      call: 'Lambda INIT',
      start: 0,
      end: init,
      detail: `A new execution environment loaded the code for ${Math.round(init).toLocaleString('en-US')} ms, from the Init Duration of the REPORT line.`,
    });
  }
  let previous = 0;
  for (const { at, piece } of marks) {
    if (at === undefined) continue;
    const end = Math.min(duration, Math.max(previous, at - started));
    if (end > previous) pieces.push({ ...piece, start: init + previous, end: init + end });
    previous = end;
  }
  if (duration > previous) pieces.push({ ...tail, start: init + previous, end: init + duration });
  return pieces;
}

const between = (from: string, to: string) => `The time from ${from} to ${to}.`;

function inboxPieces(run: HandlerRun, trail: RunTrail, duration: number) {
  const size = readOf(trail, 'email');
  return piecesOf(
    run,
    [
      {
        at: size?.at,
        piece: {
          tone: 'get',
          symbol: 'read',
          name: 'Acknowledge and read',
          call: 'RequestLedger.acknowledge · Storage.read',
          detail: `${between('the start of the handler', 'the size line of the email')}${size === undefined ? '' : ` The email is ${size.size.bytes.toLocaleString('en-US')} bytes.`}`,
        },
      },
      {
        at: changeAt(trail, (change) => change.attachments !== undefined),
        piece: {
          tone: 'parse',
          symbol: 'parse',
          name: 'Parse',
          call: 'EmailParser.parse',
          detail: between('the size line', 'the attachment count'),
        },
      },
      {
        at: changeAt(trail, (change) => change.inboxStatus !== undefined),
        piece: {
          tone: 'put',
          symbol: 'puts',
          name: 'Count and puts',
          call: 'RequestLedger.record · Storage.store',
          detail: between('the attachment count', 'the end status of the email'),
          amount: trail.attachments ?? 0,
          unit: 'source',
        },
      },
    ],
    {
      tone: 'delete',
      symbol: 'delete',
      name: 'End and delete',
      call: 'RequestLedger.record · Storage.delete',
      detail: between('the end status', 'the REPORT line'),
    },
    duration
  );
}

const isSourceEnd = (change: RequestProgress) =>
  (change.sourcesProcessed ?? 0) > 0 || (change.sourcesRejected ?? 0) > 0 || (change.sourcesFailed ?? 0) > 0;

function sourcePieces(run: HandlerRun, trail: RunTrail, duration: number) {
  const size = readOf(trail, 'source');
  return piecesOf(
    run,
    [
      {
        at: size?.at,
        piece: {
          tone: 'get',
          symbol: 'read',
          name: 'Start and read',
          call: 'RequestLedger.record · Storage.read',
          detail: `${between('the start of the handler', 'the size line of the source')}${size === undefined ? '' : ` The source is ${size.size.bytes.toLocaleString('en-US')} bytes.`}`,
        },
      },
      {
        at: changeAt(trail, (change) => change.sourcesLeads !== undefined),
        piece: {
          tone: 'parse',
          symbol: 'parse',
          name: 'Parse',
          call: 'ExcelSheetParser.parse',
          detail: between('the size line', 'the lead count'),
        },
      },
      {
        at: changeAt(trail, isSourceEnd),
        piece: {
          tone: 'send',
          symbol: 'sends',
          name: 'Count and sends',
          call: 'RequestLedger.record · Queue.pushBatch',
          detail: between('the lead count', 'the end of the source'),
          amount: trail.leadsFound,
          unit: 'lead',
        },
      },
    ],
    {
      tone: 'delete',
      symbol: 'delete',
      name: 'End and delete',
      call: 'RequestLedger.record · Storage.delete',
      detail: between('the end of the source', 'the REPORT line'),
    },
    duration
  );
}

function leadPieces(run: HandlerRun, trail: RunTrail, duration: number) {
  const others =
    run.otherRequests > 0
      ? ` The run also took the leads of ${plural(run.otherRequests, 'other request')}, so it is longer than the leads of this request need.`
      : '';
  return piecesOf(
    run,
    [
      {
        at: changeAt(trail, (change) => (change.leadsPending ?? 0) > 0),
        piece: {
          tone: 'parse',
          symbol: 'parse',
          name: 'Parse records',
          call: 'toLeadsAndRejectionsFromRecords',
          detail: between('the start of the handler', 'the leads pending of this request'),
        },
      },
      {
        at: changeAt(trail, (change) => (change.leadsPending ?? 0) < 0),
        piece: {
          tone: 'store',
          symbol: 'stores',
          name: 'Start and stores',
          call: 'RequestLedger.record · OrderRepository.store',
          detail: `${between('the leads pending', 'the end of the leads of this request')}${others}`,
          amount: trail.leadsTaken,
          unit: 'lead',
        },
      },
    ],
    {
      tone: 'ledger',
      symbol: 'end',
      name: 'End',
      call: 'RequestLedger.record',
      detail: `${between('the end of the leads of this request', 'the REPORT line')}${others}`,
    },
    duration
  );
}

/** In ms. A run without a REPORT line runs to its END line, or to the time of the read. */
function durationOf(run: HandlerRun, readAt: number) {
  if (run.durationMs !== undefined) return run.durationMs;
  const end = run.endedAt === undefined ? readAt : Date.parse(run.endedAt);
  return Math.max(0, end - Date.parse(run.startedAt));
}

function realRunsOf(
  stage: StageName,
  runs: readonly HandlerRun[],
  requestID: string,
  origin: number,
  readAt: number
): RealRun[] {
  return runs
    .map((run) => {
      const duration = durationOf(run, readAt);
      const init = run.initMs ?? 0;
      const started = Date.parse(run.startedAt) - origin;
      const trail = runTrailOf(run, requestID);
      const wave: HandlerWave = {
        start: started - init,
        end: started + duration,
        count: 1,
        init,
        ...(stage === 'leads' && { batch: trail.leadsTaken }),
      };
      const pieces =
        stage === 'inbox'
          ? inboxPieces(run, trail, duration)
          : stage === 'leadSources'
            ? sourcePieces(run, trail, duration)
            : leadPieces(run, trail, duration);
      return { run, wave, pieces };
    })
    .toSorted((a, b) => a.wave.start - b.wave.start);
}

/**
 * `amount` units in waves of `width`, released at the end of each equal part of `[from, to]`. The model releases a
 * wave at the end of its call, and the logs give only the start and the end of all the calls.
 */
function spread(from: number, to: number, amount: number, width: number): SourceArrival[] {
  if (amount <= 0) return [];
  const waves = Math.ceil(amount / Math.max(1, width));
  return Array.from({ length: waves }, (_, index) => ({
    at: from + ((index + 1) / waves) * Math.max(0, to - from),
    amount: Math.min(width, amount - index * width),
  }));
}

/** Sources that each inbox run released, spread over the time from its attachment count to its end status. */
function sourceArrivals(
  inbox: readonly RealRun[],
  sources: readonly RealRun[],
  requestID: string,
  input: SliceInputs,
  origin: number
) {
  const arrivals = inbox.flatMap(({ run }) => {
    const trail = runTrailOf(run, requestID);
    const from = changeAt(trail, (change) => change.attachments !== undefined);
    const to = changeAt(trail, (change) => change.inboxStatus !== undefined);
    if (from === undefined || to === undefined) return [];
    return spread(from - origin, to - origin, trail.attachments ?? 0, input.in_c);
  });
  // A source without an email, or an inbox run without its lines: each source arrives when its handler takes it.
  return arrivals.length > 0 ? arrivals : sources.map(({ wave }) => ({ at: wave.start, amount: 1 }));
}

/** Leads that each source run pushed, in send waves of `src_c` batches, spread over the time of its sends. */
function leadArrivals(
  sources: readonly RealRun[],
  requestID: string,
  input: SliceInputs,
  origin: number
): LeadArrival[] {
  return sources.flatMap(({ run, wave }) => {
    const trail = runTrailOf(run, requestID);
    const leads = trail.leadsFound;
    const from = changeAt(trail, (change) => change.sourcesLeads !== undefined);
    const to = changeAt(trail, isSourceEnd);
    if (from === undefined || to === undefined) return leads > 0 ? [{ at: wave.end, amount: leads }] : [];
    return spread(from - origin, to - origin, leads, input.src_c * leadBatchSize);
  });
}

/** The limits of the comparison, from what the read gave and what the model leaves out. */
function notesOf(
  entry: RequestView,
  runs: RequestRuns,
  loaded: readonly LoadedStage[],
  real: Record<LaneName, readonly RealRun[]>,
  shape: ReturnType<typeof shapeOf>
): ComparisonNote[] {
  const notes: ComparisonNote[] = [];
  for (const stage of stageNames) {
    const section = runs.stages[stage];
    if (!section.ok) {
      notes.push({
        kind: 'error',
        text: `The runs of the ${stageLabels[stage].toLowerCase()} stage did not load: ${section.error}`,
      });
    } else if (section.value.more) {
      notes.push({
        kind: 'limit',
        text: `The logs hold more of the ${stageLabels[stage].toLowerCase()} stage than one read takes: at most 50 runs and 5,000 lines for each stage. The real bars and the real cost leave the other runs out.`,
      });
    }
  }
  const all = loaded.flatMap((stage) => stage.runs);
  const running = all.filter((run) => run.durationMs === undefined).length;
  if (running > 0) {
    notes.push({
      kind: 'limit',
      text: `${plural(running, 'run')} ${running === 1 ? 'has' : 'have'} no REPORT line yet. ${running === 1 ? 'Its bar ends' : 'Their bars end'} at the time of the read, and the real cost leaves ${running === 1 ? 'its' : 'their'} time out.`,
    });
  }
  if (entry.state === 'active') {
    notes.push({ kind: 'limit', text: 'The request is still active. Read it again when it is done.' });
  }
  const truncated = all.filter((run) => run.truncated).length;
  if (truncated > 0) {
    notes.push({
      kind: 'limit',
      text: `${plural(truncated, 'run')} wrote more than ${runLineLimit} lines. The phases of ${truncated === 1 ? 'that bar' : 'those bars'} use only the first ${runLineLimit}.`,
    });
  }
  const counts = [...new Set(shape.leadsBySource)];
  if (counts.length > 1) {
    notes.push({
      kind: 'estimate',
      text: `The sources have ${counts.toSorted((a, b) => a - b).join(', ')} leads. The model gives every source the mean, L = ${shape.shape.L}.`,
    });
  }
  if (!shape.measuredRow) {
    notes.push({
      kind: 'limit',
      text: 'No source of the request has a size line and leads, so row_b stays your value.',
    });
  }
  notes.push({ kind: 'limit', text: 'The logs give no size of a queued lead, so lead_b stays your value.' });
  const shared = real.leads.filter(({ run }) => run.otherRequests > 0).length;
  if (shared > 0) {
    notes.push({
      kind: 'limit',
      text: `${plural(shared, 'lead run')} also took the leads of other requests. ${shared === 1 ? 'Its bar shows' : 'Their bars show'} the whole run. The real cost counts only the share of this request.`,
    });
  }
  if (entry.receivedAt === undefined) {
    notes.push({ kind: 'limit', text: 'The request has no email, so the clock starts at its first run.' });
  }
  notes.push({
    kind: 'estimate',
    text: 'The logs show when a handler takes a message, not when the message arrives in its queue. The real queue depth spreads the puts of each inbox run and the sends of each source run evenly over the time between two of its lines.',
  });
  notes.push({
    kind: 'estimate',
    text: 'A real bar has one range from each progress line or size line to the next, not one range for each call.',
  });
  return notes;
}

/** The real runs of the request on the clock of the simulation. `input` gives the put and send widths of the estimate. */
export function comparisonOf(
  result: { readonly entry: RequestView; readonly runs: RequestRuns },
  input: SliceInputs
): Comparison {
  const { entry, runs } = result;
  const requestID = entry.requestID;
  const loaded = loadedOf(runs);
  const readAt = Date.parse(runs.readAt);
  const starts = loaded.flatMap((stage) => stage.runs.map((run) => Date.parse(run.startedAt) - (run.initMs ?? 0)));
  const origin =
    entry.receivedAt === undefined ? (starts.length > 0 ? Math.min(...starts) : readAt) : Date.parse(entry.receivedAt);
  const real = Object.fromEntries(
    laneNames.map((lane) => [
      lane,
      realRunsOf(laneStages[lane], runsOf(loaded, laneStages[lane]), requestID, origin, readAt),
    ])
  ) as Record<LaneName, RealRun[]>;
  const shape = shapeOf(entry, loaded, input);
  const { S, L } = shape.shape;
  return {
    requestID,
    shape: shape.shape,
    leadsBySource: shape.leadsBySource,
    lanes: {
      // The email is in its queue from 0 on the clock, when the logs show that an inbox run took it.
      inbox: realLaneOf(real.inbox, real.inbox.length === 0 ? [] : [{ at: 0, amount: 1 }], 1, input.E_q_c),
      sources: realLaneOf(
        real.sources,
        sourceArrivals(real.inbox, real.sources, requestID, input, origin),
        S,
        input.S_q_c
      ),
      leads: realLaneOf(
        real.leads,
        leadArrivals(real.sources, requestID, input, origin),
        shape.leadsBySource.reduce((sum, leads) => sum + leads, 0) || S * L,
        input.L_q_c
      ),
    },
    loaded,
    origin,
    notes: notesOf(entry, runs, loaded, real, shape),
  };
}

/** What one stage did, read the same way from the model and from the real runs. Times are in ms on the clock. */
export interface StageStats {
  readonly handlers: number;
  readonly coldStarts: number;
  readonly firstStart?: number;
  readonly lastEnd?: number;
  /** The mean handler time without INIT. */
  readonly meanDuration?: number;
}

export function statsOf(run: PoolRun): StageStats {
  const handlers = run.waves.reduce((sum, wave) => sum + wave.count, 0);
  if (handlers === 0) return { handlers, coldStarts: 0 };
  const time = run.waves.reduce((sum, wave) => sum + wave.count * (wave.end - wave.start - wave.init), 0);
  return {
    handlers,
    coldStarts: run.environments,
    firstStart: Math.min(...run.waves.map((wave) => wave.start)),
    lastEnd: run.end,
    meanDuration: time / handlers,
  };
}

/** How a real value reads next to its model. */
export type Verdict = 'better' | 'same' | 'worse';

/** Two values this close, as a share of the larger one, are the same. A sum of prices has rounding noise. */
const sameShare = 0.001;

/**
 * Each number of a comparison is a time, a count of handlers or cold starts, or a cost, so a lower real value is better.
 * No verdict when one of the two values does not exist.
 */
export function verdictOf(real: number | undefined, model: number | undefined): Verdict | undefined {
  if (real === undefined || model === undefined) return undefined;
  if (Math.abs(real - model) <= sameShare * Math.max(Math.abs(real), Math.abs(model))) return 'same';
  return real < model ? 'better' : 'worse';
}

/** The stages together. The first stage gives the start, and a handler time has no meaning across the stages. */
export function wholeOf(stages: readonly StageStats[]): StageStats {
  const firstStart = stages[0]?.firstStart;
  const ends = stages.flatMap(({ lastEnd }) => (lastEnd === undefined ? [] : [lastEnd]));
  return {
    handlers: stages.reduce((sum, stage) => sum + stage.handlers, 0),
    coldStarts: stages.reduce((sum, stage) => sum + stage.coldStarts, 0),
    ...(firstStart !== undefined && { firstStart }),
    ...(ends.length > 0 && { lastEnd: Math.max(...ends) }),
  };
}

/**
 * The output of a real run: its range that releases sources or leads, from the end of its INIT. A put or a store is one
 * call for each unit; a send is one call for each batch of `leadBatchSize` leads.
 */
function outputOfRun({ wave, pieces }: RealRun): OutputStretch[] {
  return pieces.flatMap((piece) =>
    piece.amount === undefined || piece.amount <= 0
      ? []
      : [
          {
            start: piece.start - wave.init,
            end: piece.end - wave.init,
            amount: piece.amount,
            calls: piece.tone === 'send' ? Math.ceil(piece.amount / leadBatchSize) : piece.amount,
            waves: 1,
          },
        ]
  );
}

/** The real runs of one stage as a lane. `arrivals` are the estimate of when the messages reach its queue. */
function realLaneOf(runs: readonly RealRun[], arrivals: readonly SourceArrival[], total: number, cap: number): Lane {
  const byWave = new Map(runs.map((run) => [run.wave, run]));
  const own = (wave: HandlerWave) => byWave.get(wave);
  return laneOf({
    pool: poolOf(runs.map(({ wave }) => wave)),
    piecesOf: (wave) => own(wave)?.pieces ?? [],
    outputOf: (wave) => {
      const run = own(wave);
      return run === undefined ? [] : outputOfRun(run);
    },
    arrivals,
    total,
    cap,
  });
}

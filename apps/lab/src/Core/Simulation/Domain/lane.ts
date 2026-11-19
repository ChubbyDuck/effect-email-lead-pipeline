import {
  marks,
  mergeReleases,
  sourceArrivalNear,
  sourcesReleased,
  takenBy,
  type HandlerWave,
  type PoolRun,
  type SourceArrival,
} from './schedule';
import { swarm, type OutputStretch, type Swarm } from './swarm';
import type { OutputUnit, StepTone } from './timeline';

/** The lanes of the simulator, one for each stage, top to bottom. */
export const laneNames = ['inbox', 'sources', 'leads'] as const;
export type LaneName = (typeof laneNames)[number];

/**
 * One range on a handler bar, from the start of the handler, INIT included. A model range is a `Span` of the handler
 * timeline. A real range runs from one log line to the next.
 */
export interface Piece {
  readonly tone: StepTone;
  readonly symbol: string;
  readonly name: string;
  readonly call?: string;
  readonly detail: string;
  readonly start: number;
  readonly end: number;
  /** Units this range releases from one handler. */
  readonly amount?: number;
  readonly unit?: OutputUnit;
}

/** One wave of a lane, with the ranges of each of its handlers. */
export interface LaneRow {
  readonly wave: HandlerWave;
  readonly pieces: readonly Piece[];
}

/** What a lane is made of. The simulation gives the parts of the model, and a comparison the parts of the real runs. */
export interface LaneParts {
  readonly pool: PoolRun;
  readonly piecesOf: (wave: HandlerWave) => readonly Piece[];
  /** The output of one handler of the wave. */
  readonly outputOf: (wave: HandlerWave) => readonly OutputStretch[];
  /** Units that arrive in the queue in front of the lane. */
  readonly arrivals: readonly SourceArrival[];
  /** Units that enter the queue in front of the lane in all. */
  readonly total: number;
  /** The stage cap. */
  readonly cap: number;
}

/** What the simulator shows for one stage. */
export interface Lane {
  /** The waves to draw, or none past the mark limit. */
  readonly rows: readonly LaneRow[];
  /** Waves past the mark limit, which the lane does not draw. */
  readonly hidden: number;
  readonly pool: PoolRun;
  /** Arrivals into the queue in front of the lane, in time order, with equal times merged. */
  readonly releases: SourceArrival[];
  /** Units released up to and including each release. */
  readonly released: number[];
  /** Every handler of the lane as one body. */
  readonly swarm: Swarm;
  readonly total: number;
  readonly cap: number;
}

export function laneOf({ pool, piecesOf, outputOf, arrivals, total, cap }: LaneParts): Lane {
  const { waves, hidden } = marks(pool);
  return {
    rows: waves.map((wave) => ({ wave, pieces: piecesOf(wave) })),
    hidden,
    pool,
    ...mergeReleases(arrivals),
    swarm: swarm(pool, outputOf),
    total,
    cap,
  };
}

/** True when `wave` holds every handler of the lane. */
export function isWhole(lane: Lane, wave: HandlerWave) {
  return wave.count === lane.pool.started.at(-1);
}

/** The arrival into the queue in front of the lane nearest `time`, when it falls inside `within` ms. */
export function arrivalNear(lane: Lane, time: number, within: number) {
  return sourceArrivalNear(lane, time, within);
}

/** Units in the queue in front of the lane at `time`: arrived, and not yet taken by a handler. */
export function waitingAt(lane: Lane, time: number) {
  if (time < 0) return 0;
  return Math.max(0, sourcesReleased(lane, time) - takenBy(lane.pool, time));
}

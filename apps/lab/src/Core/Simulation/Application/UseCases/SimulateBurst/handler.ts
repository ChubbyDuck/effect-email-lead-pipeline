import { burstCharges, stackTotal, type StackTotal } from '#Core/Simulation/Domain/burstCharges';
import type { Charges } from '#Core/Simulation/Domain/charges';
import { emailCharges } from '#Core/Simulation/Domain/emailCharges';
import { idleCharges } from '#Core/Simulation/Domain/idleCharges';
import { inboxSpans, inboxTimeline } from '#Core/Simulation/Domain/inbox';
import { laneOf, type Lane, type LaneName, type Piece } from '#Core/Simulation/Domain/lane';
import { leadCharges } from '#Core/Simulation/Domain/leadCharges';
import { leadSpans, leadTimeline } from '#Core/Simulation/Domain/leads';
import { sliceLimits, type Limit } from '#Core/Simulation/Domain/limits';
import { scheduleSlice, type HandlerWave, type SliceSchedule } from '#Core/Simulation/Domain/schedule';
import { sourceCharges } from '#Core/Simulation/Domain/sourceCharges';
import {
  normalizeSliceInputs,
  sourceSpans,
  sourceTimeline,
  type SliceInputKey,
  type SliceInputs,
} from '#Core/Simulation/Domain/sources';
import { outputOf, type OutputStretch } from '#Core/Simulation/Domain/swarm';

import type { Command } from './command';

export type IdleCharges = ReturnType<typeof idleCharges>;

/** One burst of the simulator. It does not depend on the time, so the UI reads it at the time of its own clock. */
export type Simulation = {
  readonly knobs: SliceInputs;
  readonly schedule: SliceSchedule;
  readonly lanes: Record<LaneName, Lane>;
  readonly charges: {
    readonly email: Charges;
    readonly sources: Charges;
    readonly leads: Charges;
    readonly burst: Charges;
    readonly idle: IdleCharges;
  };
  readonly month: StackTotal;
  readonly limits: readonly Limit[];
  readonly flagged: ReadonlySet<SliceInputKey>;
  /** The end of the last wave of the three stages. */
  readonly horizon: number;
};

/** The idle polling does not depend on the knobs. */
const idle = idleCharges();

/** One value for each key of a wave, made once, as many waves share the INIT and the batch of their handlers. */
function onceFor<T>(keyOf: (wave: HandlerWave) => string | number, make: (wave: HandlerWave) => T) {
  const made = new Map<string | number, T>();
  return (wave: HandlerWave) => {
    const key = keyOf(wave);
    if (made.has(key)) return made.get(key)!;
    const value = make(wave);
    made.set(key, value);
    return value;
  };
}

const byInit = (wave: HandlerWave) => wave.init;
const byBatchAndWait = (wave: HandlerWave) => `${wave.batch ?? 1}:${wave.wait ?? 0}`;
const byInitBatchAndWait = (wave: HandlerWave) => `${wave.init}:${byBatchAndWait(wave)}`;

/** The lane of each stage: the emails, the sources, and the leads enter the queues in front of them. */
function lanesOf(knobs: SliceInputs, schedule: SliceSchedule): Record<LaneName, Lane> {
  const inboxOutput = outputOf(inboxTimeline(knobs));
  const sourceOutput = outputOf(sourceTimeline(knobs));
  return {
    inbox: laneOf({
      pool: schedule.inbox,
      piecesOf: onceFor<readonly Piece[]>(byInit, (wave) => inboxSpans(knobs, wave.init)),
      outputOf: () => inboxOutput,
      arrivals: [{ at: 0, amount: knobs.E }],
      total: knobs.E,
      cap: knobs.E_q_c,
    }),
    sources: laneOf({
      pool: schedule.sources,
      piecesOf: onceFor<readonly Piece[]>(byInit, (wave) => sourceSpans(knobs, wave.init)),
      outputOf: () => sourceOutput,
      arrivals: schedule.releases,
      total: knobs.E * knobs.S,
      cap: knobs.S_q_c,
    }),
    leads: laneOf({
      pool: schedule.leads,
      piecesOf: onceFor<readonly Piece[]>(byInitBatchAndWait, (wave) =>
        leadSpans(knobs, wave.batch ?? 1, wave.init, wave.wait)
      ),
      // The lead handlers differ by the size of their batch and by their wait, so each pair has its own output.
      outputOf: onceFor<readonly OutputStretch[]>(byBatchAndWait, (wave) =>
        outputOf(leadTimeline(knobs, wave.batch ?? 1, wave.wait))
      ),
      arrivals: schedule.leadReleases,
      total: knobs.E * knobs.S * knobs.L,
      cap: knobs.L_q_c,
    }),
  };
}

/** Puts the Simulation domain together for one set of knobs: the waves, the lanes, the charges, and the limits. */
export function handler({ knobs: raw }: Command): Simulation {
  const knobs = normalizeSliceInputs(raw);
  const schedule = scheduleSlice(knobs);
  const burst = burstCharges(knobs, schedule);
  const limits = sliceLimits(knobs);
  return {
    knobs,
    schedule,
    lanes: lanesOf(knobs, schedule),
    charges: {
      email: emailCharges(knobs, schedule),
      sources: sourceCharges(knobs, schedule),
      leads: leadCharges(knobs, schedule),
      burst,
      idle,
    },
    month: stackTotal(knobs, burst, idle),
    limits,
    flagged: new Set(limits.flatMap((limit) => limit.keys)),
    horizon: Math.max(schedule.inbox.end, schedule.sources.end, schedule.leads.end),
  };
}

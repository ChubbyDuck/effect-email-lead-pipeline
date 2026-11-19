import type { HandlerWave, PoolRun } from './schedule';
import type { Timeline } from './timeline';

/**
 * Back-to-back output calls inside one handler, measured from the end of its INIT.
 * Each wave holds `amount` units in `calls` calls, and releases them when it ends.
 */
export interface OutputStretch {
  start: number;
  end: number;
  amount: number;
  calls: number;
  waves: number;
}

/** A value that holds from `at` until the next step. Before the first step the value is 0. */
export interface Step {
  at: number;
  value: number;
}

/** The highest value of a step series, and the first time it holds. */
export interface Peak {
  at: number;
  value: number;
}

/** Every handler of one stage, read as one body: how long it runs, how wide it gets, and what it puts out. */
export interface Swarm {
  /** Start of the first handler and end of the last, on the shared clock. 0 when nothing ran. */
  start: number;
  end: number;
  /** Handlers started. */
  handlers: number;
  /** Units every handler releases together. */
  output: number;
  /** Handlers that run at each instant. */
  running: Step[];
  /** Units inside output calls that have not ended, at each instant. */
  inFlight: Step[];
  peakRunning: Peak;
  peakInFlight: Peak;
  /** Output calls that run at once, at their highest. */
  peakCalls: Peak;
}

/** The output of one handler, read off its timeline: each output step as one stretch. */
export function outputOf(timeline: Timeline): OutputStretch[] {
  return timeline.steps.flatMap(({ start, end, output }) =>
    output === undefined ? [] : [{ start, end, amount: output.amount, calls: output.calls, waves: output.waves }]
  );
}

function add(deltas: Map<number, number>, at: number, delta: number) {
  deltas.set(at, (deltas.get(at) ?? 0) + delta);
}

/** Step series from changes at instants. Instants with no net change are left out. */
function toSteps(deltas: Map<number, number>): Step[] {
  const steps: Step[] = [];
  let value = 0;
  for (const at of [...deltas.keys()].sort((a, b) => a - b)) {
    const delta = deltas.get(at)!;
    if (delta === 0) continue;
    value += delta;
    steps.push({ at, value });
  }
  return steps;
}

function peakOf(steps: readonly Step[]): Peak {
  let peak: Peak = { at: 0, value: 0 };
  for (const step of steps) if (step.value > peak.value) peak = step;
  return { at: peak.at, value: peak.value };
}

/** `stretches` are the output of one handler, or of one handler of that wave when handlers differ by batch. */
export function swarm(
  run: PoolRun,
  stretches: readonly OutputStretch[] | ((wave: HandlerWave) => readonly OutputStretch[])
): Swarm {
  const stretchesOf = typeof stretches === 'function' ? stretches : () => stretches;
  const running = new Map<number, number>();
  const units = new Map<number, number>();
  const calls = new Map<number, number>();
  let handlers = 0;
  let output = 0;
  for (const wave of run.waves) {
    handlers += wave.count;
    add(running, wave.start, wave.count);
    add(running, wave.end, -wave.count);
    const origin = wave.start + wave.init;
    const own = stretchesOf(wave);
    output += wave.count * own.reduce((sum, stretch) => sum + stretch.amount * stretch.waves, 0);
    for (const stretch of own) {
      if (!(stretch.end > stretch.start)) continue;
      add(units, origin + stretch.start, wave.count * stretch.amount);
      add(units, origin + stretch.end, -wave.count * stretch.amount);
      add(calls, origin + stretch.start, wave.count * stretch.calls);
      add(calls, origin + stretch.end, -wave.count * stretch.calls);
    }
  }
  const runningSteps = toSteps(running);
  const inFlight = toSteps(units);
  return {
    start: run.waves[0]?.start ?? 0,
    end: run.end,
    handlers,
    output,
    running: runningSteps,
    inFlight,
    peakRunning: peakOf(runningSteps),
    peakInFlight: peakOf(inFlight),
    peakCalls: peakOf(toSteps(calls)),
  };
}

/** Value of a step series at `time`. */
export function valueAt(steps: readonly Step[], time: number) {
  let low = 0;
  let high = steps.length - 1;
  let value = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (steps[middle]!.at <= time) {
      value = steps[middle]!.value;
      low = middle + 1;
    } else high = middle - 1;
  }
  return value;
}

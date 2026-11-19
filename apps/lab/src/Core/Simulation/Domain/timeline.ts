import type { SliceInputKey } from './sources';

/** What a step inside a handler does, as the simulator colors it. */
export type StepTone = 'init' | 'ledger' | 'get' | 'parse' | 'put' | 'send' | 'wait' | 'store' | 'delete';

/** What an output step releases: sources onto the sources bucket, or leads onto the leads queue or as orders. */
export type OutputUnit = 'source' | 'lead';

/** Back-to-back waves of output calls. Every wave holds the same units in the same calls and takes the same time. */
export interface StepOutput {
  readonly unit: OutputUnit;
  /** Units of one wave. The wave releases them when it ends. */
  readonly amount: number;
  /** Calls of one wave. */
  readonly calls: number;
  readonly waves: number;
}

/** One step inside a handler: one port call, or a run of equal output waves. */
export interface TimelineStep {
  readonly tone: StepTone;
  /** The knob of the time of this step. */
  readonly symbol: SliceInputKey;
  readonly name: string;
  /** Call this step stands for, as `Service.method` or a function name. */
  readonly call: string;
  readonly detail: string;
  /** From the start of the handler code, in ms. */
  readonly start: number;
  readonly end: number;
  readonly output?: StepOutput;
}

/**
 * The steps of one warm handler in their order, from the start of its code. Every other reading of a handler comes
 * from it: its duration, the ranges the simulator draws, its output, and the releases into the next queue.
 */
export interface Timeline {
  readonly steps: readonly TimelineStep[];
  /** End of the last step: how long a warm handler runs. */
  readonly duration: number;
  /** The knob of the INIT a new execution environment runs before the steps. */
  readonly init: SliceInputKey;
}

/** One step before it has a place on the timeline. `name` is the call unless it is given. */
export type StepSpec = Omit<TimelineStep, 'name' | 'start' | 'end'> & {
  readonly name?: string;
  /** ms of the whole step: every wave of an output step. */
  readonly time: number;
};

/** The steps one after the other, from 0. A step of 0 ms stays, so its output is still released. */
export function timeline(init: SliceInputKey, specs: readonly StepSpec[]): Timeline {
  let at = 0;
  const steps = specs.map(({ time, name, ...step }): TimelineStep => {
    const start = at;
    at += time;
    return { ...step, name: name ?? step.call, start, end: at };
  });
  return { steps, duration: at, init };
}

/** One wave of output calls before it has a count: its units and its calls. */
export interface OutputWave {
  readonly amount: number;
  readonly calls: number;
}

/**
 * `units` in calls of up to `perCall` units, with up to `width` calls in one wave: the full waves as one step, then the
 * last wave as a step of its own when it holds less. `step` gives the step of one wave, and the ms that wave takes.
 */
export function outputSteps(
  { units, perCall, width, unit }: { units: number; perCall: number; width: number; unit: OutputUnit },
  step: (wave: OutputWave) => Omit<StepSpec, 'time' | 'output'> & { readonly waveTime: number }
): StepSpec[] {
  const calls = Math.ceil(units / perCall);
  const count = Math.ceil(calls / width);
  if (count === 0) return [];
  const full = { amount: width * perCall, calls: width };
  const last = { amount: units - (count - 1) * full.amount, calls: calls - (count - 1) * width };
  const run = (wave: OutputWave, waves: number): StepSpec => {
    const { waveTime, ...spec } = step(wave);
    return { ...spec, time: waves * waveTime, output: { unit, ...wave, waves } };
  };
  if (last.amount === full.amount && last.calls === full.calls) return [run(full, count)];
  return [...(count > 1 ? [run(full, count - 1)] : []), run(last, 1)];
}

/** Time of the steps of one tone. */
export function timeOf(timeline: Timeline, tone: StepTone) {
  return timeline.steps.reduce((sum, step) => sum + (step.tone === tone ? step.end - step.start : 0), 0);
}

/** Units the handler releases at the end of each output wave, from the start of its code. */
export function releasesOf(timeline: Timeline): { at: number; amount: number }[] {
  const releases: { at: number; amount: number }[] = [];
  for (const { start, end, output } of timeline.steps) {
    if (output === undefined) continue;
    const wave = (end - start) / output.waves;
    for (let index = 1; index <= output.waves; index++)
      releases.push({ at: start + index * wave, amount: output.amount });
  }
  return releases;
}

/** A range on one handler bar, from the start of the handler, INIT included. */
export interface Span {
  readonly tone: StepTone;
  readonly symbol: SliceInputKey;
  readonly name: string;
  readonly call: string;
  readonly detail: string;
  readonly start: number;
  readonly end: number;
  /** Units this range releases from one handler. Only an output range has them. */
  readonly amount?: number;
  readonly unit?: OutputUnit;
  /** Output calls in this range. */
  readonly calls?: number;
}

const coldStart =
  'A new execution environment loads the code before its first message. Lambda bills this time, and the message waits for it.';

/** The ranges of every output wave as one range, with the units and the calls of them all. */
function stretchOf(outputs: readonly TimelineStep[], detail: string): TimelineStep {
  const first = outputs[0]!;
  const units = (pick: (output: StepOutput) => number) =>
    outputs.reduce((sum, step) => sum + pick(step.output!) * step.output!.waves, 0);
  return {
    ...first,
    detail,
    end: outputs.at(-1)!.end,
    output: {
      unit: first.output!.unit,
      amount: units((output) => output.amount),
      calls: units((output) => output.calls),
      waves: 1,
    },
  };
}

/**
 * The ranges of one handler that runs `init` ms of INIT before its steps. A range of 0 ms is left out.
 * Each output wave is a range of its own, unless `stretch` gives the detail of one range for all the output waves.
 */
export function spansOf(timeline: Timeline, { init = 0, stretch }: { init?: number; stretch?: string } = {}): Span[] {
  const outputs = timeline.steps.filter((step) => step.output !== undefined);
  const steps =
    stretch === undefined
      ? timeline.steps
      : timeline.steps.flatMap((step) =>
          step.output === undefined ? [step] : step === outputs[0] ? [stretchOf(outputs, stretch)] : []
        );
  const spans: Span[] = [];
  const push = (span: Span) => {
    if (span.end > span.start) spans.push(span);
  };
  push({
    tone: 'init',
    symbol: timeline.init,
    name: 'Cold start',
    call: 'Lambda INIT',
    detail: coldStart,
    start: 0,
    end: init,
  });
  for (const { output, ...step } of steps) {
    if (output === undefined) {
      push({ ...step, start: init + step.start, end: init + step.end });
      continue;
    }
    const wave = (step.end - step.start) / output.waves;
    for (let index = 0; index < output.waves; index++) {
      const start = init + step.start + index * wave;
      push({ ...step, start, end: start + wave, amount: output.amount, unit: output.unit, calls: output.calls });
    }
  }
  return spans;
}

import { inboxTimeline, type InboxInputs, type InboxTimingInputs } from './inbox';
import { leadDuration, leadsPerHandler, leadTokenWait } from './leads';
import { sourceTimeline, type SliceInputs } from './sources';
import { releasesOf, type Timeline } from './timeline';

/** Handlers of one stage that start at one instant, all warm or all cold. */
export interface HandlerWave {
  start: number;
  end: number;
  count: number;
  /** INIT before the handler code, in ms. 0 on a warm environment. */
  init: number;
  /** Messages each handler of the wave takes, when the mapping batches. One when absent. */
  batch?: number;
  /** ms each handler of the wave waits inside its run. 0 when absent. */
  wait?: number;
}

/** Messages that become visible to an event source mapping at one instant. */
export interface Burst {
  at: number;
  count: number;
}

/** How an event source mapping groups messages into one invocation. */
export interface Batching {
  /** Most messages one handler takes. */
  size: number;
  /** How long the mapping holds a partial batch, from the arrival of its oldest message, in ms. */
  window: number;
}

const single: Batching = { size: 1, window: 0 };

/** Scale-up of an SQS event source mapping: `start` invocations, then `rate` more per minute, up to `cap`. */
export interface Scaling {
  cap: number;
  start: number;
  rate: number;
}

export interface PoolRun {
  /** Waves in start order. */
  waves: HandlerWave[];
  /** Handlers started up to and including each wave. */
  started: number[];
  /** Messages taken up to and including each wave. */
  taken: number[];
  /** Execution environments created. Each one runs INIT once. */
  environments: number;
  /** End of the last handler, or 0 when nothing ran. */
  end: number;
}

/** Elapsed ms at which the mapping adds its `step`-th invocation. */
const stepAt = (scaling: Scaling, step: number) => (step * 60_000) / scaling.rate;

/** Steps the mapping has taken by `elapsed` ms after its queue first had messages. */
function stepsBy(scaling: Scaling, elapsed: number) {
  if (scaling.rate <= 0) return 0;
  const room = Math.max(0, scaling.cap - scaling.start);
  let steps = Math.min(room, Math.floor((Math.max(0, elapsed) * scaling.rate) / 60_000));
  // Correct the float estimate with the same formula the scheduler uses for its next event.
  while (steps < room && stepAt(scaling, steps + 1) <= elapsed) steps++;
  while (steps > 0 && stepAt(scaling, steps) > elapsed) steps--;
  return steps;
}

/** Concurrency the mapping allows `elapsed` ms after its queue first had messages. */
export function concurrencyAt(scaling: Scaling, elapsed: number) {
  return Math.min(scaling.cap, scaling.start + stepsBy(scaling, elapsed));
}

/** Running handlers grouped by the time they free their slot, earliest first. */
class FreeQueue {
  private readonly heap: { free: number; count: number }[] = [];
  running = 0;

  push(free: number, count: number) {
    this.running += count;
    const heap = this.heap;
    heap.push({ free, count });
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.free <= heap[index]!.free) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  }

  /** The earliest free time, or undefined when nothing runs. */
  peek() {
    return this.heap[0]?.free;
  }

  /** Removes the earliest group and returns its handler count. */
  pop() {
    const heap = this.heap;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let least = index;
        if (left < heap.length && heap[left]!.free < heap[least]!.free) least = left;
        if (right < heap.length && heap[right]!.free < heap[least]!.free) least = right;
        if (least === index) break;
        [heap[least], heap[index]] = [heap[index]!, heap[least]!];
        index = least;
      }
    }
    this.running -= top.count;
    return top.count;
  }
}

/**
 * One SQS event source mapping in front of one function.
 * A free slot takes the next waiting batch at once; nothing waits for a whole wave.
 * A full batch goes at once. A partial batch goes once its oldest message has waited the batching window.
 * A free warm environment takes it first. A slot with no warm environment creates one, which runs INIT first.
 * `duration` is the handler time, or the handler time for a batch of that many messages.
 * `waitOf` gives the ms a handler waits on top of `duration`, from its messages and the ms its environment rested
 * before it. The environment that rested longest goes first. A new environment has an infinite rest.
 */
export function runPool(
  arrivals: readonly Burst[],
  scaling: Scaling,
  duration: number | ((messages: number) => number),
  init: number,
  batching: Batching = single,
  waitOf: (messages: number, rest: number) => number = () => 0
): PoolRun {
  const bursts = arrivals.filter((burst) => burst.count > 0).sort((a, b) => a.at - b.at);
  const run: PoolRun = { waves: [], started: [], taken: [], environments: 0, end: 0 };
  const first = bursts[0];
  if (first === undefined) return run;
  const durationOf = typeof duration === 'number' ? () => duration : duration;
  const origin = first.at;
  const busy = new FreeQueue();
  // Waiting messages by arrival, oldest first, so the batching window knows how long the oldest has waited.
  const queue: Burst[] = [];
  let head = 0;
  // Free warm environments by the time they became free, oldest first.
  const rested: { free: number; count: number }[] = [];
  let oldestRested = 0;
  let idle = 0;
  let waiting = 0;
  let next = 0;
  let time = origin;
  let steps = 0;
  const room = Math.max(0, scaling.cap - scaling.start);
  const start = (count: number, cold: number, batch: number, rest: number) => {
    if (count === 0) return;
    const wait = waitOf(batch, rest);
    const end = time + cold + wait + durationOf(batch);
    const last = run.waves.at(-1);
    if (last && last.start === time && last.init === cold && (last.batch ?? 1) === batch && (last.wait ?? 0) === wait)
      last.count += count;
    else
      run.waves.push({
        start: time,
        end,
        count,
        init: cold,
        ...(batch === 1 ? {} : { batch }),
        ...(wait === 0 ? {} : { wait }),
      });
    busy.push(end, count);
    run.end = Math.max(run.end, end);
  };
  const launch = (handlers: number, batch: number) => {
    let warm = Math.min(handlers, idle);
    const cold = handlers - warm;
    idle -= warm;
    run.environments += cold;
    while (warm > 0) {
      const oldest = rested[oldestRested]!;
      const used = Math.min(warm, oldest.count);
      start(used, 0, batch, time - oldest.free);
      oldest.count -= used;
      warm -= used;
      if (oldest.count === 0) oldestRested++;
    }
    start(cold, init, batch, Number.POSITIVE_INFINITY);
    let left = handlers * batch;
    waiting -= left;
    while (left > 0) {
      const oldest = queue[head]!;
      const used = Math.min(left, oldest.count);
      oldest.count -= used;
      left -= used;
      if (oldest.count === 0) head++;
    }
  };
  for (;;) {
    while (next < bursts.length && bursts[next]!.at <= time) {
      const burst = bursts[next++]!;
      waiting += burst.count;
      queue.push({ ...burst });
    }
    while (scaling.rate > 0 && steps < room && origin + stepAt(scaling, steps + 1) <= time) steps++;
    while ((busy.peek() ?? Number.POSITIVE_INFINITY) <= time) {
      const free = busy.peek()!;
      const count = busy.pop();
      idle += count;
      rested.push({ free, count });
    }
    const free = Math.max(0, Math.min(scaling.cap, scaling.start + steps) - busy.running);
    const full = Math.min(free, Math.floor(waiting / batching.size));
    if (full > 0) launch(full, batching.size);
    const partial = free > full && waiting > 0 && waiting < batching.size && time >= queue[head]!.at + batching.window;
    if (partial) launch(1, waiting);
    if (full > 0 || partial) continue;
    if (waiting === 0 && next === bursts.length) break;
    const candidates: number[] = [];
    if (next < bursts.length) candidates.push(bursts[next]!.at);
    if (waiting > 0) {
      const freeAt = busy.peek();
      if (freeAt !== undefined) candidates.push(freeAt);
      if (scaling.rate > 0 && steps < room) candidates.push(origin + stepAt(scaling, steps + 1));
      const expiry = queue[head]!.at + batching.window;
      if (waiting < batching.size && expiry > time) candidates.push(expiry);
    }
    const later = Math.min(...candidates);
    // Every candidate is past `time`: arrivals, ends, steps and expiries at or before it are already taken in.
    if (!(later > time)) break;
    time = later;
  }
  return { ...run, ...countsOf(run.waves) };
}

/** Handlers started and messages taken up to and including each wave. */
function countsOf(waves: readonly HandlerWave[]) {
  let handlers = 0;
  let messages = 0;
  return {
    started: waves.map((wave) => (handlers += wave.count)),
    taken: waves.map((wave) => (messages += wave.count * (wave.batch ?? 1))),
  };
}

/**
 * A pool of waves in start order that `runPool` did not schedule, such as the real runs of a stage. Each handler of a
 * wave with INIT is a new environment.
 */
export function poolOf(waves: readonly HandlerWave[]): PoolRun {
  return {
    waves: [...waves],
    ...countsOf(waves),
    environments: waves.reduce((sum, wave) => sum + (wave.init > 0 ? wave.count : 0), 0),
    end: waves.reduce((end, wave) => Math.max(end, wave.end), 0),
  };
}

/** Index of the last entry at or before `time`, or -1. */
function lastAtOrBefore<T>(items: readonly T[], at: (item: T) => number, time: number) {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (at(items[middle]!) <= time) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

/** Handlers that have started by `time`. A handler takes its message when it starts. */
export function startedBy(run: PoolRun, time: number) {
  const index = lastAtOrBefore(run.waves, (wave) => wave.start, time);
  return index < 0 ? 0 : run.started[index]!;
}

/** Messages handlers have taken by `time`. A handler takes its batch when it starts. */
export function takenBy(run: PoolRun, time: number) {
  const index = lastAtOrBefore(run.waves, (wave) => wave.start, time);
  return index < 0 ? 0 : run.taken[index]!;
}

/** Waves past this are not drawn. */
export const markLimit = 2000;

export function marks(run: PoolRun) {
  if (run.waves.length <= markLimit) return { waves: run.waves, hidden: 0 };
  return { waves: [] as HandlerWave[], hidden: run.waves.length };
}

export interface SourceArrival {
  /** Clock time the sources land in the source queue. */
  at: number;
  /** Sources the inbox handlers release together at that time. */
  amount: number;
}

/** Clock time the leads land in the leads queue, and how many the source handlers push together then. */
export type LeadArrival = SourceArrival;

export interface SliceSchedule {
  inbox: PoolRun;
  /** Source releases in time order. Equal times are merged. */
  releases: SourceArrival[];
  /** Sources released up to and including each release. */
  released: number[];
  sources: PoolRun;
  /** Lead releases in time order. Equal times are merged. */
  leadReleases: LeadArrival[];
  /** Leads released up to and including each lead release. */
  leadsReleased: number[];
  leads: PoolRun;
}

/** Releases in time order from amounts by time, with the running total up to and including each one. */
function toReleases(byTime: Map<number, number>) {
  const releases = [...byTime].map(([at, amount]) => ({ at, amount })).sort((a, b) => a.at - b.at);
  let total = 0;
  const released = releases.map((release) => (total += release.amount));
  return { releases, released };
}

/** Releases in time order with equal times merged, and the running total up to and including each one. */
export function mergeReleases(arrivals: readonly SourceArrival[]) {
  const byTime = new Map<number, number>();
  for (const { at, amount } of arrivals) byTime.set(at, (byTime.get(at) ?? 0) + amount);
  return toReleases(byTime);
}

export const inboxScaling = (input: InboxInputs): Scaling => ({
  cap: input.E_q_c,
  start: input.esm_start,
  rate: input.esm_rate,
});

export const sourceScaling = (input: SliceInputs): Scaling => ({
  cap: input.S_q_c,
  start: input.esm_start,
  rate: input.esm_rate,
});

export const leadScaling = (input: SliceInputs): Scaling => ({
  cap: input.L_q_c,
  start: input.esm_start,
  rate: input.esm_rate,
});

export const leadBatching = (input: SliceInputs): Batching => ({
  size: leadsPerHandler(input),
  window: input.ld_window_t,
});

/** Units every wave of `run` releases, at the end of each output wave of `timeline`. */
function releasesOfRun(run: PoolRun, timeline: Timeline) {
  const releases = releasesOf(timeline);
  const byTime = new Map<number, number>();
  for (const wave of run.waves) {
    const origin = wave.start + wave.init;
    for (const release of releases) {
      const at = origin + release.at;
      byTime.set(at, (byTime.get(at) ?? 0) + wave.count * release.amount);
    }
  }
  return toReleases(byTime);
}

/** Emails arrive at 0. The inbox mapping sees them after `delay_in`. */
export function scheduleInbox(input: InboxTimingInputs) {
  const steps = inboxTimeline(input);
  const inbox = runPool([{ at: input.delay_in, count: input.E }], inboxScaling(input), steps.duration, input.in_init_t);
  return { inbox, ...releasesOfRun(inbox, steps) };
}

/**
 * The inbox, then the source handlers, then the lead handlers.
 * A source reaches its mapping `delay_src` after its put. A lead reaches its mapping `delay_ld` after its send.
 */
export function scheduleSlice(input: SliceInputs): SliceSchedule {
  const { inbox, releases, released } = scheduleInbox(input);
  const steps = sourceTimeline(input);
  const sources = runPool(
    releases.map((release) => ({ at: release.at + input.delay_src, count: release.amount })),
    sourceScaling(input),
    steps.duration,
    input.src_init_t
  );
  const { releases: leadReleases, released: leadsReleased } = releasesOfRun(sources, steps);
  // The pool asks for the time of a batch at every launch, and a batch size repeats.
  const leadTimes = new Map<number, number>();
  const leadTime = (batch: number) => {
    const known = leadTimes.get(batch);
    if (known !== undefined) return known;
    const time = leadDuration(input, batch);
    leadTimes.set(batch, time);
    return time;
  };
  const leads = runPool(
    leadReleases.map((release) => ({ at: release.at + input.delay_ld, count: release.amount })),
    leadScaling(input),
    leadTime,
    input.ld_init_t,
    leadBatching(input),
    (batch, rest) => leadTokenWait(input, batch, rest, leadTime(batch))
  );
  return { inbox, releases, released, sources, leadReleases, leadsReleased, leads };
}

/** Emails waiting at `time`: the burst, less every email a handler has taken. */
export function emailsWaiting(input: InboxInputs, schedule: Pick<SliceSchedule, 'inbox'>, time: number) {
  if (time < 0) return 0;
  return input.E - startedBy(schedule.inbox, time);
}

/** Sources released by `time`. */
export function sourcesReleased(schedule: Pick<SliceSchedule, 'releases' | 'released'>, time: number) {
  const index = lastAtOrBefore(schedule.releases, (release) => release.at, time);
  return index < 0 ? 0 : schedule.released[index]!;
}

/** Sources waiting at `time`: released by the inbox, not yet taken by a source handler. */
export function sourcesWaiting(schedule: SliceSchedule, time: number) {
  if (time < 0) return 0;
  return sourcesReleased(schedule, time) - startedBy(schedule.sources, time);
}

/** Leads pushed by `time`. */
export function leadsReleased(schedule: Pick<SliceSchedule, 'leadReleases' | 'leadsReleased'>, time: number) {
  const index = lastAtOrBefore(schedule.leadReleases, (release) => release.at, time);
  return index < 0 ? 0 : schedule.leadsReleased[index]!;
}

/** Leads waiting at `time`: pushed by the source handlers, not yet taken by a lead handler. */
export function leadsWaiting(schedule: SliceSchedule, time: number) {
  if (time < 0) return 0;
  return leadsReleased(schedule, time) - takenBy(schedule.leads, time);
}

/** The lead release nearest `time`, when it falls inside `within` ms. A tie goes to the later one. */
export function leadArrivalNear(schedule: Pick<SliceSchedule, 'leadReleases'>, time: number, within: number) {
  return sourceArrivalNear({ releases: schedule.leadReleases }, time, within);
}

/** The release nearest `time`, when it falls inside `within` ms. A tie goes to the later one. */
export function sourceArrivalNear(
  schedule: Pick<SliceSchedule, 'releases'>,
  time: number,
  within: number
): SourceArrival | null {
  if (!(within >= 0)) return null;
  const index = lastAtOrBefore(schedule.releases, (release) => release.at, time);
  const before = schedule.releases[index];
  const after = schedule.releases[index + 1];
  const best =
    before === undefined ? after : after === undefined ? before : after.at - time <= time - before.at ? after : before;
  return best !== undefined && Math.abs(best.at - time) <= within ? best : null;
}

import { describe, expect, it } from 'vitest';

import { outputSteps, releasesOf, spansOf, timeline, timeOf, type StepSpec } from './timeline';

const read: StepSpec = { tone: 'get', symbol: 'src_storage_read_t', call: 'Storage.read', detail: 'Read.', time: 30 };
const remove: StepSpec = {
  tone: 'delete',
  symbol: 'src_storage_delete_t',
  call: 'Storage.delete',
  detail: 'Delete.',
  time: 10,
};

/** Sends of `units` leads in batches of 10, `width` batches at once, 5 ms a wave. */
const sends = (units: number, width: number, waveTime = 5) =>
  outputSteps({ units, perCall: 10, width, unit: 'lead' }, (wave) => ({
    tone: 'send',
    symbol: 'src_queue_push_t',
    call: 'Queue.pushBatch',
    detail: `Push ${wave.calls}.`,
    waveTime,
  }));

describe('Handler timeline', () => {
  it('puts the steps one after the other and ends with the last one', () => {
    const steps = timeline('src_init_t', [read, ...sends(95, 4), remove]);
    expect(steps.steps.map((step) => [step.call, step.start, step.end])).toEqual([
      ['Storage.read', 0, 30],
      ['Queue.pushBatch', 30, 40],
      ['Queue.pushBatch', 40, 45],
      ['Storage.delete', 45, 55],
    ]);
    expect(steps.duration).toBe(55);
  });

  it('keeps the full waves as one step and the smaller last wave as its own', () => {
    expect(sends(95, 4).map((step) => [step.output, step.detail, step.time])).toEqual([
      [{ unit: 'lead', amount: 40, calls: 4, waves: 2 }, 'Push 4.', 10],
      [{ unit: 'lead', amount: 15, calls: 2, waves: 1 }, 'Push 2.', 5],
    ]);
    expect(sends(80, 4).map((step) => step.output)).toEqual([{ unit: 'lead', amount: 40, calls: 4, waves: 2 }]);
    expect(sends(0, 4)).toEqual([]);
  });

  it('releases the units of each wave when the wave ends, also after 0 ms', () => {
    expect(releasesOf(timeline('src_init_t', [read, ...sends(95, 4), remove]))).toEqual([
      { at: 35, amount: 40 },
      { at: 40, amount: 40 },
      { at: 45, amount: 15 },
    ]);
    expect(releasesOf(timeline('src_init_t', [read, ...sends(25, 2, 0)]))).toEqual([
      { at: 30, amount: 20 },
      { at: 30, amount: 5 },
    ]);
  });

  it('adds up the time of one tone', () => {
    const steps = timeline('src_init_t', [read, ...sends(95, 4), remove]);
    expect(timeOf(steps, 'send')).toBe(15);
    expect(timeOf(steps, 'store')).toBe(0);
  });
});

describe('Spans of a handler timeline', () => {
  const steps = timeline('src_init_t', [read, ...sends(95, 4), remove]);

  it('draws each output wave as a range of its own', () => {
    expect(spansOf(steps).map((span) => [span.call, span.start, span.end, span.amount, span.calls])).toEqual([
      ['Storage.read', 0, 30, undefined, undefined],
      ['Queue.pushBatch', 30, 35, 40, 4],
      ['Queue.pushBatch', 35, 40, 40, 4],
      ['Queue.pushBatch', 40, 45, 15, 2],
      ['Storage.delete', 45, 55, undefined, undefined],
    ]);
  });

  it('draws every output wave as one stretch when it is given a detail for it', () => {
    expect(
      spansOf(steps, { stretch: 'Three sends.' }).map((span) => [
        span.start,
        span.end,
        span.amount,
        span.calls,
        span.detail,
      ])
    ).toEqual([
      [0, 30, undefined, undefined, 'Read.'],
      [30, 45, 95, 10, 'Three sends.'],
      [45, 55, undefined, undefined, 'Delete.'],
    ]);
  });

  it('draws INIT first and leaves out a range of 0 ms', () => {
    const spans = spansOf(timeline('src_init_t', [{ ...read, time: 0 }, remove]), { init: 400 });
    expect(spans.map((span) => [span.tone, span.symbol, span.start, span.end])).toEqual([
      ['init', 'src_init_t', 0, 400],
      ['delete', 'src_storage_delete_t', 400, 410],
    ]);
  });
});

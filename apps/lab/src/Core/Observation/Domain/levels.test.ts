import { expect, test } from 'vitest';

import { busy, keepWatching, type Levels, observe, quietMs, type QueueLevel, watchLimitMs, withLevels } from './levels';
import type { BucketStatus, QueueStatus, Series, Snapshot } from './snapshot';

const series: Series = { start: '2026-10-14T16:00:00Z', periodSeconds: 300, values: [4] };

const queue = (role: QueueStatus['role'], visible: number): QueueStatus => ({
  name: `leads-inbox${role === 'dlq' ? '-dlq' : ''}`,
  url: '',
  stage: 'inbox',
  role,
  visible,
  inFlight: 0,
  delayed: 0,
  visibilityTimeoutSeconds: 60,
  retentionSeconds: 1_209_600,
  oldestAgeSeconds: 30,
  sent: series,
});

const bucket = (objects: number): BucketStatus => ({
  name: 'leads-inbox',
  stage: 'inbox',
  objects: Array.from({ length: objects }, (_, index) => ({
    key: `email-${index}`,
    lastModified: '2026-10-14T15:00:00Z',
    size: 10,
  })),
  truncated: false,
});

const snapshot = {
  collectedAt: '2026-10-14T16:00:00Z',
  queues: { ok: true, value: [queue('main', 0), queue('dlq', 1)] },
  buckets: { ok: true, value: [bucket(1)] },
} as unknown as Snapshot;

const level = (role: QueueLevel['role'], visible: number, inFlight = 0): QueueLevel => ({
  stage: 'inbox',
  role,
  visible,
  inFlight,
  delayed: 0,
});

const levels = (change: Partial<Levels> = {}): Levels => ({
  readAt: '2026-10-14T16:01:00Z',
  queues: { ok: true, value: [level('main', 0), level('dlq', 0)] },
  buckets: { ok: true, value: [bucket(0)] },
  ...change,
});

test('puts the counts of newer levels on the snapshot, and keeps its metrics', () => {
  const leveled = withLevels(snapshot, levels({ queues: { ok: true, value: [level('main', 0, 1), level('dlq', 0)] } }));

  expect(leveled.queues).toEqual({
    ok: true,
    value: [{ ...queue('main', 0), inFlight: 1 }, queue('dlq', 0)],
  });
  expect(leveled.buckets).toEqual({ ok: true, value: [bucket(0)] });
  expect(leveled.collectedAt).toBe(snapshot.collectedAt);
});

test('keeps the snapshot when the levels are older', () => {
  expect(withLevels(snapshot, levels({ readAt: '2026-10-14T15:59:00Z' }))).toBe(snapshot);
});

test('keeps a section of the snapshot when the levels could not read it', () => {
  const leveled = withLevels(snapshot, levels({ queues: { ok: false, error: 'denied' } }));

  expect(leveled.queues).toBe(snapshot.queues);
  expect(leveled.buckets).toEqual({ ok: true, value: [bucket(0)] });
});

test('is busy only while a main queue has a message', () => {
  expect(busy(levels())).toBe(false);
  expect(busy(levels({ queues: { ok: true, value: [level('main', 0), level('dlq', 3)] } }))).toBe(false);
  expect(busy(levels({ queues: { ok: true, value: [level('main', 0, 1), level('dlq', 0)] } }))).toBe(true);
});

test('watches until no count changed and no main queue had a message for the quiet time', () => {
  const start = { startedAt: 0, activeAt: 0 };
  const first = observe(start, levels(), 2_000);
  expect(first.activeAt).toBe(2_000);

  const same = observe(first, levels(), 4_000);
  expect(same.activeAt).toBe(2_000);
  expect(keepWatching(same, 2_000 + quietMs - 1)).toBe(true);
  expect(keepWatching(same, 2_000 + quietMs)).toBe(false);

  const working = observe(same, levels({ queues: { ok: true, value: [level('main', 0, 1), level('dlq', 0)] } }), 6_000);
  expect(working.activeAt).toBe(6_000);
  const stillWorking = observe(
    working,
    levels({ queues: { ok: true, value: [level('main', 0, 1), level('dlq', 0)] } }),
    8_000
  );
  expect(stillWorking.activeAt).toBe(8_000);
});

test('does not count a failed read as activity, and stops at the limit', () => {
  const watch = { startedAt: 0, activeAt: 1_000 };
  expect(observe(watch, undefined, 5_000)).toBe(watch);
  expect(keepWatching({ startedAt: 0, activeAt: watchLimitMs }, watchLimitMs)).toBe(false);
});

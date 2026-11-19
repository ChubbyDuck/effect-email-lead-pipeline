import type { StageName } from '@leads/shared/domain/stages';
import { expect, test } from 'vitest';

import type { Finding, Place } from '#Core/Observation/Domain/health';
import type { BucketStatus, HandlerStatus, QueueStatus, Series } from '#Core/Observation/Domain/snapshot';

import { findingsByPlace, stageHealth, tableHealth } from './Flow';

const series = (...values: number[]): Series => ({ start: '2026-10-09T11:00:00Z', periodSeconds: 300, values });

const handler = (change: Partial<HandlerStatus> = {}): HandlerStatus => ({
  stage: 'leadSources',
  functionName: 'lead-sources-function',
  state: 'Active',
  lastUpdateStatus: 'Successful',
  lastModified: '2026-10-09T13:29:18.000+0000',
  timeoutSeconds: 300,
  memoryMb: 1536,
  mapping: { state: 'Enabled', batchSize: 1 },
  invocations: series(3, 1),
  errors: series(0, 0),
  throttles: series(0, 0),
  durationMax: series(450, 120),
  concurrencyMax: series(3, 1),
  ...change,
});

const queue = (role: QueueStatus['role'], change: Partial<QueueStatus> = {}): QueueStatus => ({
  name: `lead-sources${role === 'dlq' ? '-dlq' : ''}`,
  url: '',
  stage: 'leadSources' satisfies StageName,
  role,
  visible: 0,
  inFlight: 0,
  delayed: 0,
  visibilityTimeoutSeconds: 1800,
  retentionSeconds: 1_209_600,
  sent: series(0),
  ...change,
});

const bucket = (objects: number, truncated = false): BucketStatus => ({
  name: 'leads-lead-sources',
  stage: 'leadSources',
  objects: Array.from({ length: objects }, (_, index) => ({
    key: `object-${index}`,
    lastModified: '2026-10-09T13:00:00Z',
    size: 10,
  })),
  truncated,
});

const finding = (level: Finding['level'], part: Place['part'] = 'handler'): Finding => ({
  level,
  subject: 'subject',
  message: 'message',
  place: part === 'table' ? { stage: 'orders', part } : { stage: 'leadSources', part },
});

test('shows a stage that ran and holds nothing as clear', () => {
  expect(stageHealth({ handler: handler(), main: queue('main'), dlq: queue('dlq'), bucket: bucket(0) }, [])).toEqual({
    tone: 'ok',
    text: 'clear',
  });
});

test('shows a stage without runs as idle', () => {
  expect(stageHealth({ handler: handler({ invocations: series(0, 0) }) }, [])).toEqual({
    tone: 'neutral',
    text: 'idle',
  });
  expect(stageHealth({}, [])).toEqual({ tone: 'neutral', text: 'idle' });
});

test('colors a stage with findings by the worst of them and counts them', () => {
  const findings = [finding('warning'), finding('critical', 'dlq'), finding('warning', 'bucket')];

  expect(stageHealth({ handler: handler(), bucket: bucket(1) }, findings)).toEqual({
    tone: 'critical',
    text: '1 critical, 2 warnings',
  });
});

test('shows a finding that the parts of the stage do not show', () => {
  const failedUpdate = handler({ lastUpdateStatus: 'Failed' });

  expect(stageHealth({ handler: failedUpdate }, [finding('critical')])).toEqual({
    tone: 'critical',
    text: '1 critical',
  });
});

test('shows objects in the bucket without a finding as work in progress', () => {
  expect(stageHealth({ handler: handler(), bucket: bucket(2, true) }, [])).toEqual({
    tone: 'info',
    text: '2+ in the bucket',
  });
});

test('shows messages in the queue without a finding as work in progress', () => {
  expect(stageHealth({ handler: handler(), main: queue('main', { visible: 2, inFlight: 1 }) }, [])).toEqual({
    tone: 'info',
    text: '3 in the queue',
  });
});

test('shows the health of the orders table from its findings', () => {
  expect(tableHealth([])).toEqual({ tone: 'ok', text: 'accepts writes' });
  expect(tableHealth([finding('warning', 'table')])).toEqual({ tone: 'warning', text: '1 warning' });
});

test('puts each finding with a place on its box, in the order of the list', () => {
  const findings: Finding[] = [
    { level: 'critical', subject: 'dlq', message: '', place: { stage: 'leadSources', part: 'dlq' } },
    { level: 'warning', subject: 'Logs', message: '' },
    { level: 'warning', subject: 'handler', message: 'slow', place: { stage: 'leads', part: 'handler' } },
    { level: 'info', subject: 'handler', message: 'idle', place: { stage: 'leads', part: 'handler' } },
  ];

  const byPlace = findingsByPlace(findings);

  expect([...byPlace.keys()]).toEqual(['leadSources/dlq', 'leads/handler']);
  expect(byPlace.get('leadSources/dlq')).toEqual([findings[0]]);
  expect(byPlace.get('leads/handler')).toEqual([findings[2], findings[3]]);
});

import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, test } from 'vitest';

import { assess, assessmentOf, overall, type Finding } from './health';
import type { Levels } from './levels';
import type { BucketStatus, DeploymentStatus, HandlerStatus, QueueStatus, Series, Snapshot } from './snapshot';

const now = new Date('2026-10-09T14:00:00Z');

const series = (...values: number[]): Series => ({ start: '2026-10-09T11:00:00Z', periodSeconds: 300, values });

const handler = (stage: StageName, change: Partial<HandlerStatus> = {}): HandlerStatus => ({
  stage,
  functionName: `${stage}-function`,
  state: 'Active',
  lastUpdateStatus: 'Successful',
  lastModified: '2026-10-09T13:29:18.000+0000',
  timeoutSeconds: 300,
  memoryMb: 1536,
  mapping: { state: 'Enabled', batchSize: 1, maximumConcurrency: 50 },
  invocations: series(3, 3, 1),
  errors: series(0, 0, 0),
  throttles: series(0, 0, 0),
  durationMax: series(450, 400, 120),
  concurrencyMax: series(3, 3, 1),
  ...change,
});

const queue = (stage: StageName, role: QueueStatus['role'], change: Partial<QueueStatus> = {}): QueueStatus => ({
  name: `leads-${stage}${role === 'dlq' ? '-dlq' : ''}`,
  url: '',
  stage,
  role,
  visible: 0,
  inFlight: 0,
  delayed: 0,
  visibilityTimeoutSeconds: 1800,
  retentionSeconds: 1_209_600,
  sent: series(0),
  ...change,
});

const stages: StageName[] = ['inbox', 'leadSources', 'leads'];

const healthy: Snapshot = {
  deployment: 'production-cdk',
  region: 'eu-north-1',
  collectedAt: now.toISOString(),
  windowHours: 3,
  deploymentStatus: {
    ok: true,
    value: {
      tool: 'cdk',
      name: 'LeadsStack',
      phase: 'complete',
      status: 'UPDATE_COMPLETE',
      updatedAt: '2026-10-09T13:29:00Z',
    },
  },
  handlers: { ok: true, value: stages.map((stage) => handler(stage)) },
  queues: { ok: true, value: stages.flatMap((stage) => [queue(stage, 'main'), queue(stage, 'dlq')]) },
  buckets: { ok: true, value: [] },
  orders: {
    ok: true,
    value: { name: 'orders', status: 'ACTIVE', itemCount: 10, sizeBytes: 100, writes: series(1), throttles: series(0) },
  },
  settings: {
    ok: true,
    value: {
      environmentState: 'READY_FOR_DEPLOYMENT',
      deployment: { number: 2, state: 'COMPLETE', version: '2', startedAt: '2026-10-09T08:00:00Z' },
    },
  },
  logs: { ok: true, value: [] },
  usage: { ok: true, value: { handlers: [], queues: [], tables: [], emailBytes: [], metricsPerRead: 0 } },
};

const withSection = <K extends keyof Snapshot>(key: K, value: Snapshot[K]): Snapshot => ({ ...healthy, [key]: value });

const subjects = (findings: readonly Finding[]) => findings.map(({ level, subject }) => `${level} ${subject}`);

test('finds no problem in a healthy workflow', () => {
  const findings = assess(healthy, now);

  expect(findings).toEqual([]);
  expect(overall(findings)).toBe('ok');
});

test('reports a section that the source cannot read', () => {
  const findings = assess(withSection('logs', { ok: false, error: 'ExpiredToken: the session expired' }), now);

  expect(findings).toEqual([
    { level: 'warning', subject: 'Logs', message: 'Cannot read: ExpiredToken: the session expired' },
  ]);
});

test('reports a message that waits in flight after a failed invocation as a future DLQ entry', () => {
  const snapshot = {
    ...withSection('handlers', {
      ok: true,
      value: stages.map((stage) => handler(stage, stage === 'leadSources' ? { errors: series(0, 0, 1) } : {})),
    }),
    queues: {
      ok: true as const,
      value: stages.flatMap((stage) => [
        queue(stage, 'main', stage === 'leadSources' ? { inFlight: 1 } : {}),
        queue(stage, 'dlq'),
      ]),
    },
  };

  const findings = assess(snapshot, now);

  expect(subjects(findings)).toEqual(['warning Lead sources handler', 'warning leads-leadSources']);
  expect(findings[1]?.message).toBe(
    '1 message in flight after a failed invocation. When the visibility timeout of 30 min ends, ' +
      'it moves to leads-leadSources-dlq.'
  );
  expect(findings.map(({ place }) => place)).toEqual([
    { stage: 'leadSources', part: 'handler' },
    { stage: 'leadSources', part: 'queue' },
  ]);
});

test('does not report a message in flight while its handler has no errors', () => {
  const findings = assess(withSection('queues', { ok: true, value: [queue('inbox', 'main', { inFlight: 4 })] }), now);

  expect(findings).toEqual([]);
});

test.each([
  ['visible', { visible: 2 }],
  ['in flight', { inFlight: 1 }],
])('reports a dead-letter queue with a message %s as critical', (_, change) => {
  const findings = assess(withSection('queues', { ok: true, value: [queue('leads', 'dlq', change)] }), now);

  expect(subjects(findings)).toEqual(['critical leads-leads-dlq']);
  expect(findings[0]?.place).toEqual({ stage: 'leads', part: 'dlq' });
  expect(overall(findings)).toBe('critical');
});

test('makes the verb agree with the count of failed messages', () => {
  const messages = (visible: number) =>
    assess(withSection('queues', { ok: true, value: [queue('leads', 'dlq', { visible })] }), now).map(
      ({ message }) => message
    );

  expect(messages(1)).toEqual(['1 message failed and waits for a redrive.']);
  expect(messages(3)).toEqual(['3 messages failed and wait for a redrive.']);
});

test('reports a backlog only when the oldest message is older than five minutes', () => {
  const fresh = queue('leads', 'main', { visible: 40, oldestAgeSeconds: 60 });
  const old = queue('inbox', 'main', { visible: 3, oldestAgeSeconds: 900 });

  const findings = assess(withSection('queues', { ok: true, value: [fresh, old] }), now);

  expect(findings).toEqual([
    {
      level: 'warning',
      subject: 'leads-inbox',
      message: '3 messages wait. The oldest is 15 min old.',
      place: { stage: 'inbox', part: 'queue' },
    },
  ]);
});

describe('handlers', () => {
  const assessHandler = (change: Partial<HandlerStatus>) =>
    assess(withSection('handlers', { ok: true, value: [handler('leads', change)] }), now);

  test('reports a disabled queue trigger as critical', () => {
    expect(subjects(assessHandler({ mapping: { state: 'Disabled', batchSize: 10 } }))).toEqual([
      'critical Leads handler',
    ]);
  });

  test('reports a function that is not active as critical', () => {
    expect(subjects(assessHandler({ state: 'Failed', lastUpdateStatus: 'Failed' }))).toEqual([
      'critical Leads handler',
      'critical Leads handler',
    ]);
  });

  test('places a finding of a handler on its handler', () => {
    expect(assessHandler({ errors: series(1) })[0]?.place).toEqual({ stage: 'leads', part: 'handler' });
  });

  test('counts the failed and the throttled invocations of the window', () => {
    const findings = assessHandler({ errors: series(1, 0, 2), throttles: series(0, 5, 0) });

    expect(findings.map(({ message }) => message)).toEqual([
      '3 invocations failed in the last 3 hours.',
      '5 invocations were throttled in the last 3 hours.',
    ]);
  });

  test('reports a run near the timeout', () => {
    const findings = assessHandler({ timeoutSeconds: 60, durationMax: series(10_000, 50_000) });

    expect(findings.map(({ message }) => message)).toEqual([
      'The longest run took 50.0 s of the 60 s timeout, for $0.00125 = 1.5 GB × 50 s × $0.0000166667 per GB-s + $0.0000002 per call.',
    ]);
  });
});

describe('buckets', () => {
  const object = (minutesAgo: number) => ({
    key: `key-${minutesAgo}`,
    lastModified: new Date(now.getTime() - minutesAgo * 60_000).toISOString(),
    size: 1,
  });
  const bucket = (...minutesAgo: number[]): BucketStatus => ({
    name: 'bucket-stage',
    stage: 'leadSources',
    objects: minutesAgo.map(object),
    truncated: false,
  });

  test('reports the objects that stay in a stage bucket longer than 15 minutes', () => {
    const findings = assess(withSection('buckets', { ok: true, value: [bucket(1, 20, 50)] }), now);

    expect(findings).toEqual([
      {
        level: 'warning',
        subject: 'bucket-stage',
        message: '2 objects older than 15 min (the oldest 50 min). A handler keeps an object only when it fails.',
        place: { stage: 'leadSources', part: 'bucket' },
      },
    ]);
  });

  test('writes the age of an old object in days and hours', () => {
    const findings = assess(withSection('buckets', { ok: true, value: [bucket(5695)] }), now);

    expect(findings[0]?.message).toBe(
      '1 object older than 15 min (the oldest 3 d 22 h). A handler keeps an object only when it fails.'
    );
  });

  test('does not report an object that a handler can still take', () => {
    expect(assess(withSection('buckets', { ok: true, value: [bucket(1, 14)] }), now)).toEqual([]);
  });
});

describe('the deployment status', () => {
  const status = (change: Partial<DeploymentStatus>): DeploymentStatus => ({
    tool: 'cdk',
    name: 'LeadsStack',
    phase: 'complete',
    status: 'UPDATE_COMPLETE',
    updatedAt: now.toISOString(),
    ...change,
  });

  test.each([
    { tool: 'cdk', phase: 'failed', status: 'UPDATE_ROLLBACK_COMPLETE', level: 'critical' },
    { tool: 'cdk', phase: 'in-progress', status: 'UPDATE_IN_PROGRESS', level: 'info' },
    { tool: 'alchemy', phase: 'failed', status: 'rolled-back', level: 'critical' },
    { tool: 'alchemy', phase: 'in-progress', status: 'updating', level: 'info' },
  ] as const)('reports the $phase phase of a $tool deployment as $level', ({ tool, phase, status: raw, level }) => {
    const findings = assess(
      withSection('deploymentStatus', { ok: true, value: status({ tool, phase, status: raw }) }),
      now
    );

    expect(subjects(findings)).toEqual([`${level} LeadsStack`]);
    expect(findings[0]?.place).toBeUndefined();
  });

  test('reads the phase, not the words of the tool', () => {
    expect(
      assess(withSection('deploymentStatus', { ok: true, value: status({ status: 'UPDATE_FAILED' }) }), now)
    ).toEqual([]);
  });

  test('gives the status and the reason of a failed deployment, as before', () => {
    const findings = assess(
      withSection('deploymentStatus', {
        ok: true,
        value: status({ phase: 'failed', status: 'UPDATE_ROLLBACK_COMPLETE', reason: 'Resource update cancelled' }),
      }),
      now
    );

    expect(findings[0]?.message).toBe('The stack is in UPDATE_ROLLBACK_COMPLETE: Resource update cancelled.');
  });

  test('says that a deployment is in progress, with the status of the tool', () => {
    const findings = assess(
      withSection('deploymentStatus', {
        ok: true,
        value: status({ phase: 'in-progress', status: 'UPDATE_IN_PROGRESS' }),
      }),
      now
    );

    expect(findings[0]?.message).toBe('A deployment is in progress (UPDATE_IN_PROGRESS).');
  });
});

test('places a throttled write on the orders table', () => {
  const findings = assess(
    withSection('orders', {
      ok: true,
      value: { name: 'orders', status: 'ACTIVE', itemCount: 1, sizeBytes: 1, writes: series(1), throttles: series(1) },
    }),
    now
  );

  expect(findings).toEqual([
    {
      level: 'warning',
      subject: 'orders',
      message: '1 write was throttled in the last 3 hours.',
      place: { stage: 'orders', part: 'table' },
    },
  ]);
});

test('reports a rolled-back deployment of the runtime settings as critical', () => {
  const findings = assess(
    withSection('settings', {
      ok: true,
      value: {
        environmentState: 'ROLLED_BACK',
        deployment: { number: 3, state: 'ROLLED_BACK', version: '3', startedAt: now.toISOString() },
      },
    }),
    now
  );

  expect(subjects(findings)).toEqual(['critical Runtime settings', 'critical Runtime settings']);
});

test('counts the warnings in the logs as information', () => {
  const event = { stage: 'leadSources' as const, time: now.toISOString(), message: 'Runtime settings are stale' };
  const findings = assess(
    withSection('logs', {
      ok: true,
      value: [
        { ...event, level: 'warn' },
        { ...event, level: 'error' },
      ],
    }),
    now
  );

  expect(findings).toEqual([{ level: 'info', subject: 'Logs', message: '1 warning in the last 3 hours.' }]);
});

test('puts the worst finding first', () => {
  const findings = assess(
    {
      ...withSection('logs', { ok: true, value: [{ stage: 'inbox', time: '', level: 'warn', message: '' }] }),
      queues: { ok: true, value: [queue('inbox', 'dlq', { visible: 1 })] },
      orders: { ok: false, error: 'AccessDenied' },
    },
    now
  );

  expect(findings.map(({ level }) => level)).toEqual(['critical', 'warning', 'info']);
});

describe('assessment', () => {
  const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const levels = (change: Partial<Levels> = {}): Levels => ({
    readAt: later(1),
    queues: { ok: true, value: [] },
    buckets: { ok: true, value: [] },
    ...change,
  });
  const leadsDlq = { stage: 'leads', role: 'dlq', visible: 2, inFlight: 0, delayed: 0 } as const;

  test('assesses a snapshot without levels at the time that it was read', () => {
    expect(assessmentOf(healthy)).toEqual({ snapshot: healthy, findings: [], overall: 'ok' });
  });

  test('assesses the snapshot with the counts of newer levels', () => {
    const result = assessmentOf(healthy, levels({ queues: { ok: true, value: [leadsDlq] } }));

    expect(subjects(result.findings)).toEqual(['critical leads-leads-dlq']);
    expect(result.overall).toBe('critical');
    expect(result.countsAt).toBe(later(1));
    expect(
      result.snapshot.queues.ok &&
        result.snapshot.queues.value.find((queue) => queue.role === 'dlq' && queue.stage === 'leads')?.visible
    ).toBe(2);
  });

  test('measures the age of an object at the time of the levels', () => {
    const object = { key: 'key', lastModified: new Date(now.getTime() - 10 * 60_000).toISOString(), size: 1 };
    const bucket: BucketStatus = { name: 'bucket-stage', stage: 'leadSources', objects: [object], truncated: false };

    expect(
      assessmentOf(healthy, levels({ readAt: later(1), buckets: { ok: true, value: [bucket] } })).findings
    ).toEqual([]);
    expect(
      subjects(assessmentOf(healthy, levels({ readAt: later(10), buckets: { ok: true, value: [bucket] } })).findings)
    ).toEqual(['warning bucket-stage']);
  });

  test('ignores levels that are older than the snapshot', () => {
    const old = levels({ readAt: later(-1), queues: { ok: true, value: [leadsDlq] } });

    expect(assessmentOf(healthy, old)).toEqual({ snapshot: healthy, findings: [], overall: 'ok' });
  });
});

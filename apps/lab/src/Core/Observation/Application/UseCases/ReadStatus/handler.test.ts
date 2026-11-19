import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, it } from 'vitest';

import type { DlqMessages } from '#Core/Observation/Domain/dlq';
import type { QueueStatus, Series, Snapshot } from '#Core/Observation/Domain/snapshot';
import type { DlqSource } from '#Core/Observation/Ports/DlqSource';
import type { StatusSource } from '#Core/Observation/Ports/StatusSource';

import { handler } from './handler';

const series = (...values: number[]): Series => ({ start: '2026-10-09T11:00:00Z', periodSeconds: 300, values });

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

const snapshotWith = (queues: Snapshot['queues']): Snapshot => ({
  deployment: 'production-cdk',
  region: 'eu-north-1',
  collectedAt: '2026-10-09T14:00:00Z',
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
  handlers: { ok: true, value: [] },
  queues,
  buckets: { ok: true, value: [] },
  orders: {
    ok: true,
    value: { name: 'orders', status: 'ACTIVE', itemCount: 10, sizeBytes: 100, writes: series(1), throttles: series(0) },
  },
  settings: { ok: true, value: { environmentState: 'READY_FOR_DEPLOYMENT' } },
  logs: { ok: true, value: [] },
  usage: { ok: true, value: { handlers: [], queues: [], tables: [], emailBytes: [], metricsPerRead: 0 } },
});

const dlqOf = (stage: StageName, requestIDs: readonly string[]): DlqMessages => ({
  deployment: 'production-cdk',
  region: 'eu-north-1',
  stage,
  queueName: `leads-${stage}-dlq`,
  readAt: '2026-10-09T14:00:00Z',
  approximateCount: requestIDs.length,
  messages: requestIDs.map((requestID, index) => ({
    message: { messageId: `${stage}-${index}`, attributes: {}, body: {} },
    objects: [],
    requestIDs: [requestID],
  })),
});

const fakeStatus = (snapshot: Snapshot): StatusSource & { readonly windows: number[] } => {
  const windows: number[] = [];
  return {
    windows,
    read: (windowHours) => {
      windows.push(windowHours);
      return Promise.resolve(snapshot);
    },
  };
};

const fakeDlq = (peek: (stage: StageName) => Promise<DlqMessages>): DlqSource & { readonly peeked: StageName[] } => {
  const peeked: StageName[] = [];
  return {
    peeked,
    peek: (stage) => {
      peeked.push(stage);
      return peek(stage);
    },
  };
};

const queues: Snapshot['queues'] = {
  ok: true,
  value: [
    queue('inbox', 'main', { visible: 4 }),
    queue('inbox', 'dlq'),
    queue('leadSources', 'main'),
    queue('leadSources', 'dlq', { visible: 1 }),
    queue('leads', 'main'),
    queue('leads', 'dlq', { inFlight: 1 }),
  ],
};

describe('ReadStatus', () => {
  it('reads the snapshot of the window', async () => {
    const status = fakeStatus(snapshotWith(queues));

    const result = await handler(
      { windowHours: 6 },
      { status, dlq: fakeDlq((stage) => Promise.resolve(dlqOf(stage, []))) }
    );

    expect(status.windows).toEqual([6]);
    expect(result).toMatchObject({ ok: true, snapshot: snapshotWith(queues) });
  });

  it('reads only the DLQs that have messages', async () => {
    const dlq = fakeDlq((stage) => Promise.resolve(dlqOf(stage, stage === 'leads' ? ['request-a'] : ['request-b'])));

    const result = await handler({ windowHours: 3 }, { status: fakeStatus(snapshotWith(queues)), dlq });

    expect(dlq.peeked).toEqual(['leadSources', 'leads']);
    expect(result).toMatchObject({
      ok: true,
      deadLetters: { ok: true, value: { 'request-a': { leads: 1 }, 'request-b': { leadSources: 1 } } },
    });
  });

  it('gives a failed section, not a failed status, when a DLQ read fails', async () => {
    const dlq = fakeDlq((stage) =>
      stage === 'leads' ? Promise.reject(new Error('AccessDenied')) : Promise.resolve(dlqOf(stage, []))
    );

    const result = await handler({ windowHours: 3 }, { status: fakeStatus(snapshotWith(queues)), dlq });

    expect(result).toMatchObject({ ok: true, deadLetters: { ok: false, error: 'AccessDenied' } });
  });

  it('gives the error of the queues as the section when the snapshot has no queues', async () => {
    const dlq = fakeDlq((stage) => Promise.resolve(dlqOf(stage, [])));

    const result = await handler(
      { windowHours: 3 },
      { status: fakeStatus(snapshotWith({ ok: false, error: 'ExpiredToken' })), dlq }
    );

    expect(dlq.peeked).toEqual([]);
    expect(result).toMatchObject({ ok: true, deadLetters: { ok: false, error: 'ExpiredToken' } });
  });

  it('assesses the snapshot and gives the overall level', async () => {
    const result = await handler(
      { windowHours: 3 },
      { status: fakeStatus(snapshotWith(queues)), dlq: fakeDlq((stage) => Promise.resolve(dlqOf(stage, []))) }
    );

    expect(result.ok && result.findings.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ ok: true, overall: 'critical' });
  });

  it('gives a failed status when the snapshot read fails', async () => {
    const status: StatusSource = { read: () => Promise.reject(new Error('Unknown environment')) };

    const result = await handler(
      { windowHours: 3 },
      { status, dlq: fakeDlq((stage) => Promise.resolve(dlqOf(stage, []))) }
    );

    expect(result).toEqual({ ok: false, error: 'Unknown environment' });
  });
});

import { describe, expect, it } from 'vitest';

import type { Levels } from '#Core/Observation/Domain/levels';

import { handler } from './handler';

const levels: Levels = {
  readAt: '2026-10-09T14:00:00Z',
  queues: { ok: true, value: [{ stage: 'leads', role: 'dlq', visible: 2, inFlight: 0, delayed: 0 }] },
  buckets: { ok: false, error: 'AccessDenied' },
};

describe('ReadLevels', () => {
  it('gives the levels that the source reads', async () => {
    expect(await handler({ levels: { read: () => Promise.resolve(levels) } })).toEqual({ ok: true, levels });
  });

  it('gives the error when the source fails', async () => {
    const result = await handler({ levels: { read: () => Promise.reject(new Error('Throttling')) } });

    expect(result).toEqual({ ok: false, error: 'Throttling' });
  });
});

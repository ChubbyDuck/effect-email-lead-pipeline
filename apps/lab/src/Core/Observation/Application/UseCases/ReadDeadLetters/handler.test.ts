import type { StageName } from '@leads/shared/domain/stages';
import { describe, expect, it } from 'vitest';

import type { DlqMessages } from '#Core/Observation/Domain/dlq';
import type { DlqSource } from '#Core/Observation/Ports/DlqSource';

import { handler } from './handler';

const messagesOf = (stage: StageName): DlqMessages => ({
  deployment: 'production-cdk',
  region: 'eu-north-1',
  stage,
  queueName: `leads-${stage}-dlq`,
  readAt: '2026-10-18T12:00:00.000Z',
  approximateCount: 1,
  messages: [
    {
      message: { messageId: 'm1', attributes: {}, body: { requestID: 'r1' } },
      objects: [],
      requestIDs: ['r1'],
    },
  ],
});

/** A DLQ source that keeps each message: every peek gives the same messages. */
function fakeDlq() {
  const peeked: StageName[] = [];
  const dlq: DlqSource = {
    peek: (stage) => {
      peeked.push(stage);
      return Promise.resolve(messagesOf(stage));
    },
  };
  return { dlq, peeked };
}

describe('ReadDeadLetters', () => {
  it('reads the DLQ of the stage of the command', async () => {
    const { dlq, peeked } = fakeDlq();

    const result = await handler({ stage: 'leadSources' }, { dlq });

    expect(peeked).toEqual(['leadSources']);
    expect(result).toEqual(messagesOf('leadSources'));
  });

  it('leaves each message in its DLQ, so a second read gives the same messages', async () => {
    const { dlq } = fakeDlq();

    const first = await handler({ stage: 'leads' }, { dlq });
    const second = await handler({ stage: 'leads' }, { dlq });

    expect(second.messages).toEqual(first.messages);
  });

  it('fails with the failure of the source', async () => {
    const failure = new Error('access denied');
    const dlq: DlqSource = { peek: () => Promise.reject(failure) };

    await expect(handler({ stage: 'inbox' }, { dlq })).rejects.toBe(failure);
  });
});

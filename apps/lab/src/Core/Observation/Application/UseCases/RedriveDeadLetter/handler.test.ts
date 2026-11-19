import { describe, expect, it } from 'vitest';

import type { Redriven } from '#Core/Observation/Domain/dlq';
import { type DlqRedrive, MessageNotInDlq, RedriveNotDeleted } from '#Core/Observation/Ports/DlqRedrive';

import type { Command } from './command';
import { handler } from './handler';

const command: Command = { stage: 'leadSources', messageId: 'm1' };

const failingWith = (error: Error): DlqRedrive => ({ redrive: () => Promise.reject(error) });

describe('RedriveDeadLetter', () => {
  it('sends the message of the command back to the main queue of its stage', async () => {
    const calls: [string, string][] = [];
    const dlqRedrive: DlqRedrive = {
      redrive: (stage, messageId) => {
        calls.push([stage, messageId]);
        return Promise.resolve<Redriven>({ messageId, sentMessageId: 'sent-1', queueName: `leads-${stage}` });
      },
    };

    const redriven = await handler(command, { dlqRedrive });

    expect(calls).toEqual([['leadSources', 'm1']]);
    expect(redriven).toEqual({ messageId: 'm1', sentMessageId: 'sent-1', queueName: 'leads-leadSources' });
  });

  it('fails when the DLQ no longer has the message', async () => {
    const dlqRedrive = failingWith(new MessageNotInDlq('m1', 'leads-lead-sources-dlq'));

    await expect(handler(command, { dlqRedrive })).rejects.toBeInstanceOf(MessageNotInDlq);
  });

  it('keeps the original failure in the reason of a failed delete', async () => {
    const failure = new Error('receipt expired');
    const dlqRedrive = failingWith(new RedriveNotDeleted('m1', failure));

    const error = await handler(command, { dlqRedrive }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(RedriveNotDeleted);
    expect((error as RedriveNotDeleted).reason).toBe(failure);
    expect((error as RedriveNotDeleted).message).toContain('receipt expired');
  });
});

import { RequestID, sourceEnded, type RequestProgress } from '@leads/shared/domain/request';
import { unimplemented } from '@leads/shared/testing/variants';
import { Data, Effect, Exit } from 'effect';
import { describe, expect, test } from 'vitest';

import { FileNotDeleted, Storage } from '#Core/Pipeline/Ports/Storage';
import { storageBuilder } from '#Infrastructure/Pipeline/Storage/mock/variants';

import { runWithPorts } from './application.test.helpers';
import { withHandlerOutcome } from './outcome';

const requestID = RequestID.make('request-1');
const file = { bucket: 'lead-sources', key: 'source.xlsx' };

class Unreadable extends Data.TaggedError('Unreadable') {}
class LeadsLost extends Data.TaggedError('LeadsLost')<{ readonly leads: number }> {}
class NotHandled extends Data.TaggedError('NotHandled')<{ readonly reason: unknown }> {}

/** The source end, so a failed end can count the leads of its reason. */
const outcomeOf = (work: Effect.Effect<void, Unreadable | LeadsLost>) =>
  withHandlerOutcome(work, {
    requestID,
    file,
    rejections: ['Unreadable'],
    ended: (outcome, reason) => sourceEnded(outcome, reason instanceof LeadsLost ? reason.leads : 0),
    notHandled: (reason) => new NotHandled({ reason }),
  });

const recordCall = (progress: RequestProgress) => ({ method: 'record', params: [requestID, progress] });
const deleteCall = { method: 'delete', params: [file.bucket, file.key] };
const defect = new Error('boom');
const unimplementedDelete = unimplemented(Storage, 'delete');

describe('Handler outcome', () => {
  test('ends processed work as processed, then deletes the file', async () => {
    const result = await runWithPorts(Effect.void.pipe(outcomeOf));

    expect(result.exit).toEqual(Exit.succeed(undefined));
    expect(result.requestLedger.calls).toEqual([recordCall(sourceEnded('processed'))]);
    expect(result.storage.calls).toEqual([deleteCall]);
    expect(result.loggedErrors()).toEqual([]);
  });

  test('logs a rejection, ends it as rejected, deletes the file, and succeeds', async () => {
    const result = await runWithPorts(Effect.fail(new Unreadable()).pipe(outcomeOf));

    expect(result.exit).toEqual(Exit.succeed(undefined));
    expect(result.loggedErrors()).toEqual([new Unreadable()]);
    expect(result.requestLedger.calls).toEqual([recordCall(sourceEnded('rejected'))]);
    expect(result.storage.calls).toEqual([deleteCall]);
  });

  test('wraps any other failure, logs it, ends it as failed with its reason, and keeps the file', async () => {
    const lost = new LeadsLost({ leads: 4 });
    const result = await runWithPorts(Effect.fail(lost).pipe(outcomeOf));

    expect(result.exit).toEqual(Exit.fail(new NotHandled({ reason: lost })));
    expect(result.loggedErrors()).toEqual([new NotHandled({ reason: lost })]);
    expect(result.requestLedger.calls).toEqual([recordCall(sourceEnded('failed', 4))]);
    expect(result.storage.calls).toEqual([]);
  });

  test('wraps a defect of the work as a failure', async () => {
    const result = await runWithPorts(Effect.die(defect).pipe(outcomeOf));

    expect(result.exit).toEqual(Exit.fail(new NotHandled({ reason: defect })));
    expect(result.loggedErrors()).toEqual([new NotHandled({ reason: defect })]);
    expect(result.requestLedger.calls).toEqual([recordCall(sourceEnded('failed'))]);
    expect(result.storage.calls).toEqual([]);
  });

  test('logs a warning after four failed deletes, and succeeds', async () => {
    const result = await runWithPorts(Effect.void.pipe(outcomeOf), {
      storage: storageBuilder.delete('failsWithFileNotDeleted'),
    });

    expect(result.exit).toEqual(Exit.succeed(undefined));
    expect(result.storage.calls).toEqual([deleteCall, deleteCall, deleteCall, deleteCall]);
    expect(result.loggedWarnings()).toMatchObject([expect.any(FileNotDeleted)]);
    expect(result.loggedErrors()).toEqual([]);
  });

  test.each([
    ['processed', Effect.void],
    ['rejected', Effect.fail(new Unreadable())],
  ] as const)('fails on a defect of the delete after %s work, but writes no second end', async (outcome, work) => {
    const result = await runWithPorts(outcomeOf(work), { storage: storageBuilder });

    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.exit).toMatchObject(Exit.fail({ _tag: 'NotHandled', reason: unimplementedDelete }));
    expect(result.requestLedger.calls).toEqual([recordCall(sourceEnded(outcome))]);
  });

  test('keeps an interruption alone: no end, no log, no delete', async () => {
    const result = await runWithPorts(Effect.interrupt.pipe(outcomeOf));

    expect(Exit.hasInterrupts(result.exit)).toBe(true);
    expect(result.requestLedger.calls).toEqual([]);
    expect(result.storage.calls).toEqual([]);
    expect(result.loggedErrors()).toEqual([]);
  });
});

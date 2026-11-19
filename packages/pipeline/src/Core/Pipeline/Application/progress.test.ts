import { RequestID, progressLogMessage, sourceEnded, sourceStarted } from '@leads/shared/domain/request';
import { requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { RequestLedger, RequestNotRecorded } from '@leads/shared/ports/RequestLedger';
import { unimplemented } from '@leads/shared/testing/variants';
import { Effect, Exit } from 'effect';
import { describe, expect, test } from 'vitest';

import { runWithPorts } from './application.test.helpers';
import { makeProgressRecorder } from './progress';

const requestID = RequestID.make('request-1');
const started = sourceStarted();
const recordCall = { method: 'record', params: [requestID, started] };

const recordStart = makeProgressRecorder.pipe(Effect.andThen((progress) => progress.record(requestID, started)));

describe('Progress recorder', () => {
  test('logs the progress, then writes it to the ledger', async () => {
    const result = await runWithPorts(recordStart);

    expect(result.exit).toEqual(Exit.succeed(undefined));
    expect(result.loggedInfos()).toEqual([progressLogMessage(requestID, started)]);
    expect(result.requestLedger.calls).toEqual([recordCall]);
  });

  test('logs a warning after four failed writes, keeps the log of the progress, and succeeds', async () => {
    const result = await runWithPorts(recordStart, {
      requestLedger: requestLedgerBuilder.record('failsWithRequestNotRecorded'),
    });

    expect(result.exit).toEqual(Exit.succeed(undefined));
    expect(result.requestLedger.calls).toEqual([recordCall, recordCall, recordCall, recordCall]);
    expect(result.loggedInfos()).toContain(progressLogMessage(requestID, started));
    expect(result.loggedWarnings()).toMatchObject([{ _tag: 'RequestNotRecorded', requestID, progress: started }]);
    expect(result.loggedWarnings()[0]).toBeInstanceOf(RequestNotRecorded);
  });

  test('logs a defect of the write as a warning, and succeeds', async () => {
    const result = await runWithPorts(recordStart, { requestLedger: requestLedgerBuilder });

    expect(result.exit).toEqual(Exit.succeed(undefined));
    expect(result.loggedWarnings()).toMatchObject([{ message: unimplemented(RequestLedger, 'record').message }]);
  });

  test('writes only the first end of the work on one request', async () => {
    const result = await runWithPorts(
      Effect.gen(function* () {
        const progress = yield* makeProgressRecorder;
        const end = yield* progress.makeEnd(requestID);
        yield* end(sourceEnded('processed'));
        yield* end(sourceEnded('failed'));
      })
    );

    expect(result.requestLedger.calls).toEqual([{ method: 'record', params: [requestID, sourceEnded('processed')] }]);
  });
});

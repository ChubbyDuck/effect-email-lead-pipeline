import { leadBatchEnded, leadBatchStarted } from '@leads/shared/domain/request';
import { requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { RequestLedger, RequestNotRecorded } from '@leads/shared/ports/RequestLedger';
import { unimplemented } from '@leads/shared/testing/variants';
import { Cause, Exit } from 'effect';
import { describe, expect, test } from 'vitest';

import {
  AuthenticationFailed,
  OrderRepository,
  OrderStoreFailed,
  OrderStoreTimedOut,
} from '#Core/Pipeline/Ports/OrderRepository';
import {
  crashingLeadDefect,
  orderRepositoryBuilder,
  type StoreAttempt,
} from '#Infrastructure/Pipeline/OrderRepository/mock/variants';

import { LeadNotHandled } from './handler';
import {
  command,
  commandForLeads,
  lead,
  leadProcessingRetry,
  makeHandleLeadScenario,
  record,
  recordForLead,
  sourceRequest,
} from './handler.test.helpers';

type ScenarioResult = Awaited<ReturnType<ReturnType<typeof makeHandleLeadScenario>['run']>>;

function attemptsOf(attempts: readonly StoreAttempt[], name: string) {
  return attempts.filter((attempt) => attempt.lead === name);
}

const byName = (a: ReturnType<typeof lead>, b: ReturnType<typeof lead>) =>
  (a.extracted.name ?? '').localeCompare(b.extracted.name ?? '');

const unimplementedStore = unimplemented(OrderRepository, 'store');
const timedOut = new Cause.TimeoutError("Operation timed out after '5s'");

const startCall = (leads: number, requestID: string = sourceRequest) => ({
  method: 'record',
  params: [requestID, leadBatchStarted(leads)],
});
const endCall = (processed: number, failed: number, requestID: string = sourceRequest) => ({
  method: 'record',
  params: [requestID, leadBatchEnded({ processed, failed })],
});

/**
 * The handler returns one LeadNotHandled for each message that goes to the DLQ, and logs each one as an error,
 * because the DLQ message does not carry the reason. A reason can be an asymmetric matcher.
 */
function expectNotHandled(result: ScenarioResult, reasons: ReadonlyArray<readonly [string, unknown]>) {
  if (!Exit.isSuccess(result.exit)) throw new Error('Expected a successful Exit');
  const notHandled = result.exit.value;
  expect(notHandled.map(({ messageId }) => messageId)).toEqual(reasons.map(([messageId]) => messageId));
  expect(notHandled).toEqual(reasons.map(([messageId, reason]) => new LeadNotHandled({ messageId, reason })));
  for (const error of notHandled) expect(error).toBeInstanceOf(LeadNotHandled);
  expect(result.loggedErrors()).toEqual(notHandled);
  expect(result.loggedWarnings()).toEqual([]);
}

// Store case IDs retain their original T6 stage even though storage is now the first port call.
describe('given no implemented services', () => {
  test('[HL-T6-U] returns and logs the message with the store defect', async () => {
    const result = await makeHandleLeadScenario().run();

    expectNotHandled(result, [['message-0', expect.objectContaining(unimplementedStore)]]);
    expect(result.orderRepository.calls).toEqual([]);
    expect(result.requestLedger.calls).toEqual([startCall(1), endCall(0, 1)]);
  });

  test('[HL-H2-empty] skips storage and returns no message for no records', async () => {
    const result = await makeHandleLeadScenario().run(commandForLeads());

    expectNotHandled(result, []);
    expect(result.orderRepository.calls).toEqual([]);
    expect(result.requestLedger.calls).toEqual([]);
  });

  test('[HL-H1-all-rejected] returns and logs every rejected record without storing', async () => {
    const result = await makeHandleLeadScenario().run({
      ...command,
      records: [record('invalid-json', 'not json'), record('invalid-lead', JSON.stringify({ lead: {} }))],
    });

    expectNotHandled(result, [
      ['invalid-json', expect.objectContaining({ message: expect.any(String) })],
      ['invalid-lead', expect.objectContaining({ message: expect.stringContaining('Expected') })],
    ]);
    expect(result.orderRepository.calls).toEqual([]);
    expect(result.requestLedger.calls).toEqual([]);
  });
});

describe("given OrderRepository.store as 'failsWithAuthenticationFailed'", () => {
  const orderRepository = orderRepositoryBuilder.store('failsWithAuthenticationFailed');

  test('[HL-T6-E1] retries three times, then returns and logs the message with the terminal failure', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run();

    expectNotHandled(result, [['message-0', new AuthenticationFailed({ reason: 'unavailable' })]]);
    expect(result.orderRepository.calls).toEqual(
      Array.from({ length: leadProcessingRetry + 1 }, () => ({ method: 'store', params: [lead('Acme')] }))
    );
  });
});

describe("given OrderRepository.store as 'failsWithOrderStoreTimedOut'", () => {
  const orderRepository = orderRepositoryBuilder.store('failsWithOrderStoreTimedOut');

  test('[HL-T6-E2] retries three times, then returns and logs the message with the terminal timeout', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run();

    expectNotHandled(result, [['message-0', new OrderStoreTimedOut({ reason: 'unavailable' })]]);
    expect(result.orderRepository.calls).toHaveLength(leadProcessingRetry + 1);
  });
});

describe("given OrderRepository.store as 'failsWithOrderStoreFailed'", () => {
  const orderRepository = orderRepositoryBuilder.store('failsWithOrderStoreFailed');

  test('[HL-T6-E3] does not retry, and returns and logs the message with the store failure', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run();

    expectNotHandled(result, [['message-0', new OrderStoreFailed({ reason: 'unavailable' })]]);
    expect(result.orderRepository.calls).toEqual([{ method: 'store', params: [lead('Acme')] }]);
  });
});

describe("given OrderRepository.store as 'followsLeadScripts'", () => {
  const orderRepository = orderRepositoryBuilder.store('followsLeadScripts');
  const scenario = () => makeHandleLeadScenario({ orderRepository });

  test('[HL-H2-one-of-two] attempts the whole batch and returns only the failed message', async () => {
    const result = await scenario().run(commandForLeads('Broken', 'Acme'));

    expectNotHandled(result, [['message-0', new OrderStoreFailed({ reason: 'unavailable' })]]);
    expect(result.orderRepository.calls.map(({ params }) => params[0]).toSorted(byName)).toEqual([
      lead('Acme'),
      lead('Broken'),
    ]);
    expect(result.orderRepository.attempts).toHaveLength(2);
    expect(attemptsOf(result.orderRepository.attempts, 'Acme')).toMatchObject([{ outcome: 'succeeded' }]);
    expect(attemptsOf(result.orderRepository.attempts, 'Broken')).toMatchObject([{ outcome: 'OrderStoreFailed' }]);
    expect(result.requestLedger.calls).toEqual([startCall(2), endCall(1, 1)]);
  });

  test('[HL-H3-retry-recovers] retries Flaky twice and handles its message after success at 3.3s', async () => {
    const run = scenario().start(commandForLeads('Flaky'));

    await run.adjust('2.5 seconds');
    expect(run.orderRepository.attempts).toEqual([
      { lead: 'Flaky', attempt: 1, startedAt: 0, outcome: 'OrderStoreTimedOut', endedAt: 1_000 },
      { lead: 'Flaky', attempt: 2, startedAt: 1_100, outcome: 'OrderStoreTimedOut', endedAt: 2_100 },
      { lead: 'Flaky', attempt: 3, startedAt: 2_300, outcome: 'pending', endedAt: undefined },
    ]);
    expect(run.loggedErrors()).toEqual([]);

    await run.adjust('1 second');
    const result = await run.done();

    expectNotHandled(result, []);
    expect(result.orderRepository.attempts[2]).toMatchObject({ outcome: 'succeeded', endedAt: 3_300 });
  });

  test('[HL-H3-retries-exhausted] returns Exhausted after the fourth AuthenticationFailed at 4.7s', async () => {
    const run = scenario().start(commandForLeads('Exhausted'));

    await run.adjust('3.8 seconds');
    expect(run.orderRepository.attempts.map(({ startedAt, outcome }) => ({ startedAt, outcome }))).toEqual([
      { startedAt: 0, outcome: 'AuthenticationFailed' },
      { startedAt: 1_100, outcome: 'AuthenticationFailed' },
      { startedAt: 2_300, outcome: 'AuthenticationFailed' },
      { startedAt: 3_700, outcome: 'pending' },
    ]);
    expect(run.loggedErrors()).toEqual([]);

    await run.adjust('1 second');
    const result = await run.done();

    expectNotHandled(result, [['message-0', new AuthenticationFailed({ reason: 'unavailable' })]]);
    expect(result.orderRepository.attempts).toHaveLength(leadProcessingRetry + 1);
    expect(result.orderRepository.attempts[3]).toMatchObject({ outcome: 'AuthenticationFailed', endedAt: 4_700 });
  });

  test('[HL-H3-timeout-mid-wait] counts the waits in the timeout, and returns Exhausted during its third wait', async () => {
    const run = makeHandleLeadScenario({ orderRepository, retryDelay: 500 }).start(commandForLeads('Exhausted'));

    await run.adjust('5 seconds');
    const result = await run.done();

    expectNotHandled(result, [['message-0', timedOut]]);
    expect(result.orderRepository.attempts.map(({ startedAt, endedAt }) => ({ startedAt, endedAt }))).toEqual([
      { startedAt: 0, endedAt: 1_000 },
      { startedAt: 1_500, endedAt: 2_500 },
      { startedAt: 3_500, endedAt: 4_500 },
    ]);
  });

  test('[HL-H3-timeout-mid-retry] interrupts the third Stalled attempt at 5s and returns its message', async () => {
    const run = scenario().start(commandForLeads('Stalled'));

    await run.adjust('5 seconds');
    const result = await run.done();

    expectNotHandled(result, [['message-0', timedOut]]);
    expect(result.orderRepository.attempts).toEqual([
      { lead: 'Stalled', attempt: 1, startedAt: 0, outcome: 'OrderStoreTimedOut', endedAt: 2_000 },
      { lead: 'Stalled', attempt: 2, startedAt: 2_100, outcome: 'OrderStoreTimedOut', endedAt: 4_100 },
      { lead: 'Stalled', attempt: 3, startedAt: 4_300, outcome: 'interrupted', endedAt: 5_000 },
    ]);
  });

  test('[HL-H3-concurrency-and-timeout] frees a slot for Acme and returns only Hanging after timeout', async () => {
    const run = scenario().start(commandForLeads('Slow', 'Hanging', 'Acme'));

    await run.adjust('1 second');
    expect(run.orderRepository.attempts).toEqual([
      { lead: 'Slow', attempt: 1, startedAt: 0, outcome: 'pending', endedAt: undefined },
      { lead: 'Hanging', attempt: 1, startedAt: 0, outcome: 'pending', endedAt: undefined },
    ]);

    await run.adjust('1 second');
    expect(attemptsOf(run.orderRepository.attempts, 'Slow')).toMatchObject([{ outcome: 'succeeded', endedAt: 2_000 }]);
    expect(attemptsOf(run.orderRepository.attempts, 'Acme')).toEqual([
      { lead: 'Acme', attempt: 1, startedAt: 2_000, outcome: 'succeeded', endedAt: 2_000 },
    ]);
    expect(run.loggedErrors()).toEqual([]);

    await run.adjust('3 seconds');
    const result = await run.done();

    expectNotHandled(result, [['message-1', timedOut]]);
    expect(attemptsOf(result.orderRepository.attempts, 'Hanging')).toMatchObject([
      { outcome: 'interrupted', endedAt: 5_000 },
    ]);
  });

  test('[HL-H3-defect-interrupts] keeps completed work and returns the crashed and interrupted messages with the defect', async () => {
    const run = scenario().start(commandForLeads('Acme', 'Crashing', 'Slow'));

    await run.adjust('1 second');
    const result = await run.done();

    expectNotHandled(result, [
      ['message-1', crashingLeadDefect],
      ['message-2', crashingLeadDefect],
    ]);
    expect(attemptsOf(result.orderRepository.attempts, 'Acme')).toMatchObject([{ outcome: 'succeeded', endedAt: 0 }]);
    expect(attemptsOf(result.orderRepository.attempts, 'Crashing')).toMatchObject([
      { outcome: 'died', endedAt: 1_000 },
    ]);
    expect(attemptsOf(result.orderRepository.attempts, 'Slow')).toMatchObject([
      { outcome: 'interrupted', endedAt: 1_000 },
    ]);
    expect(result.requestLedger.calls).toEqual([startCall(3), endCall(1, 2)]);
  });

  test('[HL-H4-interrupted] propagates external interruption and interrupts the running attempt', async () => {
    const run = scenario().start(commandForLeads('Slow'));

    await run.adjust('1 second');
    await run.interrupt();
    const result = await run.done();

    expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
    expect(result.orderRepository.attempts).toEqual([
      { lead: 'Slow', attempt: 1, startedAt: 0, outcome: 'interrupted', endedAt: 1_000 },
    ]);
    expect(result.requestLedger.calls).toEqual([startCall(1)]);
    expect(result.loggedErrors()).toEqual([]);
    expect(result.loggedWarnings()).toEqual([]);
  });
});

describe("given OrderRepository.store as 'succeeds'", () => {
  const orderRepository = orderRepositoryBuilder.store('succeeds');

  test('[HL-H1-rejected] stores the valid lead and returns the rejected records for a redrive', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run({
      ...command,
      records: [
        recordForLead('message-valid', 'Acme'),
        record('message-empty', ''),
        record('message-malformed', '{"lead":'),
        record('message-invalid', JSON.stringify({ lead: { extraction_source: 'unknown' } })),
      ],
    });

    expectNotHandled(result, [
      ['message-empty', expect.objectContaining({ message: expect.any(String) })],
      ['message-malformed', expect.objectContaining({ message: expect.any(String) })],
      ['message-invalid', expect.objectContaining({ message: expect.stringContaining('Expected') })],
    ]);
    expect(result.orderRepository.calls).toEqual([{ method: 'store', params: [lead('Acme')] }]);
    expect(result.requestLedger.calls).toEqual([startCall(1), endCall(1, 0)]);
  });

  test('[HL-P-no-request-id] returns a record without a request ID as rejected, and does not count it', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run({
      ...command,
      records: [recordForLead('message-0', 'Acme'), record('message-1', JSON.stringify({ lead: lead('Beta') }))],
    });

    expectNotHandled(result, [
      ['message-1', expect.objectContaining({ message: expect.stringContaining('requestID') })],
    ]);
    expect(result.orderRepository.calls).toEqual([{ method: 'store', params: [lead('Acme')] }]);
    expect(result.requestLedger.calls).toEqual([startCall(1), endCall(1, 0)]);
  });

  test('[HL-H5-duplicate-id] stores only the last decoded lead for a repeated message ID', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run({
      ...command,
      records: [recordForLead('same-id', 'First'), recordForLead('same-id', 'Last')],
    });

    expectNotHandled(result, []);
    expect(result.orderRepository.calls).toEqual([{ method: 'store', params: [lead('Last')] }]);
    expect(result.requestLedger.calls).toEqual([startCall(1), endCall(1, 0)]);
  });

  test('[HL-OK] stores every complete lead once and returns no message', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run(commandForLeads('Acme', 'Beta'));

    expectNotHandled(result, []);
    expect(result.orderRepository.calls.map(({ params }) => params[0]).toSorted(byName)).toEqual([
      lead('Acme'),
      lead('Beta'),
    ]);
    expect(result.requestLedger.calls).toEqual([startCall(2), endCall(2, 0)]);
  });

  test('[HL-P-one-write-per-request] writes one start and one end for a batch of ten leads of one request', async () => {
    const names = Array.from({ length: 10 }, (_, index) => `Lead ${index}`);
    const result = await makeHandleLeadScenario({ orderRepository }).run(commandForLeads(...names));

    expectNotHandled(result, []);
    expect(result.orderRepository.calls).toHaveLength(10);
    expect(result.requestLedger.calls).toEqual([startCall(10), endCall(10, 0)]);
  });

  test('[HL-P-many-requests] counts the leads of each request in the batch only for that request', async () => {
    const result = await makeHandleLeadScenario({ orderRepository }).run({
      ...command,
      records: [
        recordForLead('message-0', 'Acme', 'request-a'),
        recordForLead('message-1', 'Beta', 'request-b'),
        recordForLead('message-2', 'Gamma', 'request-a'),
      ],
    });

    expectNotHandled(result, []);
    expect(result.requestLedger.calls).toEqual([
      startCall(2, 'request-a'),
      startCall(1, 'request-b'),
      endCall(2, 0, 'request-a'),
      endCall(1, 0, 'request-b'),
    ]);
  });

  test('[HL-P-record-defect] logs a defect of each progress write as a warning, and still stores the leads', async () => {
    const result = await makeHandleLeadScenario({ orderRepository, requestLedger: requestLedgerBuilder }).run(
      commandForLeads('Acme', 'Beta')
    );

    expect(result.exit).toEqual(Exit.succeed([]));
    expect(result.orderRepository.calls).toHaveLength(2);
    expect(result.loggedWarnings()).toEqual([
      expect.objectContaining({
        message: unimplemented(RequestLedger, 'record').message,
      }),
      expect.objectContaining({
        message: unimplemented(RequestLedger, 'record').message,
      }),
    ]);
    expect(result.loggedErrors()).toEqual([]);
  });

  test('[HL-P-not-recorded] logs a warning after four failed records of each change, and still stores the leads', async () => {
    const result = await makeHandleLeadScenario({
      orderRepository,
      requestLedger: requestLedgerBuilder.record('failsWithRequestNotRecorded'),
    }).run(commandForLeads('Acme', 'Beta'));

    expect(result.exit).toEqual(Exit.succeed([]));
    expect(result.orderRepository.calls).toHaveLength(2);
    expect(result.requestLedger.calls).toEqual([
      ...Array.from({ length: 4 }, () => startCall(2)),
      ...Array.from({ length: 4 }, () => endCall(2, 0)),
    ]);
    expect(result.loggedWarnings(RequestNotRecorded)).toMatchObject([
      { requestID: sourceRequest, progress: leadBatchStarted(2), reason: 'unavailable' },
      { requestID: sourceRequest, progress: leadBatchEnded({ processed: 2, failed: 0 }), reason: 'unavailable' },
    ]);
    expect(result.loggedWarnings()).toHaveLength(2);
    expect(result.loggedErrors()).toEqual([]);
  });
});

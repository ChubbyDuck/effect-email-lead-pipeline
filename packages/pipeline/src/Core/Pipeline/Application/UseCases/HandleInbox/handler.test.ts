import { attachmentsCounted, fileSizeLogMessage, inboxEnded, type RequestProgress } from '@leads/shared/domain/request';
import { requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { RequestNotRecorded } from '@leads/shared/ports/RequestLedger';
import { unimplemented } from '@leads/shared/testing/variants';
import { Cause, type Context, Exit } from 'effect';
import { describe, expect, test } from 'vitest';

import { EmailNotParsed, EmailParser } from '#Core/Pipeline/Ports/EmailParser';
import { Guard, Unauthorized } from '#Core/Pipeline/Ports/Guard';
import { FileNotDeleted, Storage } from '#Core/Pipeline/Ports/Storage';
import { authentication, emailParserBuilder } from '#Infrastructure/Pipeline/EmailParser/mock/variants';
import { guardBuilder } from '#Infrastructure/Pipeline/Guard/mock/variants';
import { storageBuilder } from '#Infrastructure/Pipeline/Storage/mock/variants';

import { InboxEventNotHandled } from './handler';
import { command, makeHandleInboxScenario, requestID } from './handler.test.helpers';

/** The handler acknowledges the email as pending before it reads the email. */
const acknowledgeCall = {
  method: 'acknowledge',
  params: [{ requestID: requestID, receivedAt: command.receivedAt, inboxStatus: 'pending' }],
};
const recordCall = (progress: RequestProgress) => ({ method: 'record', params: [requestID, progress] });
const processedCall = recordCall(inboxEnded('processed'));
const rejectedCall = recordCall(inboxEnded('rejected'));
const failedCall = recordCall(inboxEnded('failed'));
const attachmentsCall = (attachments: number) => recordCall(attachmentsCounted(attachments));
const readCall = { method: 'read', params: [command.bucket, command.key] };
const deleteCall = { method: 'delete', params: [command.bucket, command.key] };
/** The Guard gets the whole parsed email, so it can check the From headers and the SES authentication. */
const authorizeCall = {
  method: 'authorize',
  params: [expect.objectContaining({ senders: ['sender@example.com'], authentication })],
};

const storedKey = (name: string) => `15-01-2024/14-30/${requestID}/${name}`;

const fileNotRead = {
  _tag: 'InboxEventNotHandled',
  reason: {
    _tag: 'FileNotRead',
    bucket: 'inbox',
    key: command.key,
    reason: 'unavailable',
    message: `File could not be read from bucket: inbox with key: ${command.key}`,
  },
  command,
  message: `Inbox event from inbox with key: ${command.key} is not handled due to: File could not be read from bucket: inbox with key: ${command.key}`,
};

const attachmentsNotStored = (key: string) => ({
  _tag: 'InboxEventNotHandled',
  command,
  reason: {
    _tag: 'AttachmentsNotStored',
    failures: [
      {
        _tag: 'FileNotStored',
        file: { bucket: 'lead-sources', key },
        reason: 'unavailable',
      },
    ],
  },
});

function expectSucceeded(exit: Exit.Exit<unknown, unknown>) {
  expect(exit).toEqual(Exit.succeed(undefined));
}

function expectFailed(
  exit: Exit.Exit<unknown, unknown>,
  expected: {
    readonly fails?: readonly unknown[];
    readonly defects?: readonly unknown[];
    readonly interrupts?: number;
  }
) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error('Expected a failed Exit');

  const fails = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
  const defects = exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect);
  expect(exit.cause.reasons).toHaveLength(
    (expected.fails?.length ?? 0) + (expected.defects?.length ?? 0) + (expected.interrupts ?? 0)
  );
  expect(fails).toHaveLength(expected.fails?.length ?? 0);
  expect(defects).toHaveLength(expected.defects?.length ?? 0);
  expect(fails).toMatchObject(expected.fails ?? []);
  expect(defects).toMatchObject(expected.defects ?? []);
  expect(exit.cause.reasons.filter(Cause.isInterruptReason)).toHaveLength(expected.interrupts ?? 0);
  return fails;
}

/** The handler logs the InboxEventNotHandled it fails with, because the DLQ message does not carry the reason. */
function expectLoggedFailure(result: {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly loggedErrors: (errorClass: typeof InboxEventNotHandled) => InboxEventNotHandled[];
}) {
  const fails = Exit.isFailure(result.exit)
    ? result.exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
    : [];
  expect(fails).toHaveLength(1);
  expect(result.loggedErrors(InboxEventNotHandled)).toEqual(fails);
}

function expectWrappedUnimplemented(
  exit: Exit.Exit<unknown, unknown>,
  port: Context.Key<unknown, unknown>,
  method: string
) {
  const fails = expectFailed(exit, {
    fails: [{ _tag: 'InboxEventNotHandled', command, reason: unimplemented(port, method) }],
  });
  expect(fails[0]).toBeInstanceOf(InboxEventNotHandled);
}

function storedKeys(calls: readonly { readonly method: string; readonly params: readonly unknown[] }[]) {
  return calls
    .filter((call) => call.method === 'storeOrSkip')
    .map((call) => (call.params[0] as { readonly key: string }).key)
    .toSorted();
}

describe("given RequestLedger.acknowledge as 'failsWithRequestNotAcknowledged'", () => {
  const requestLedger = requestLedgerBuilder.acknowledge('failsWithRequestNotAcknowledged').record('succeeds');

  test('[HI-T1-E] fails with InboxEventNotHandled after RequestLedger.acknowledge retries are exhausted', async () => {
    const result = await makeHandleInboxScenario({ requestLedger }).run();

    const fails = expectFailed(result.exit, {
      fails: [
        {
          _tag: 'InboxEventNotHandled',
          command,
          reason: { _tag: 'RequestNotAcknowledged', request: acknowledgeCall.params[0], reason: 'unavailable' },
        },
      ],
    });
    expect(fails[0]).toBeInstanceOf(InboxEventNotHandled);
    expect(result.requestLedger.calls).toEqual([
      acknowledgeCall,
      acknowledgeCall,
      acknowledgeCall,
      acknowledgeCall,
      failedCall,
    ]);
    expect(result.storage.calls).toEqual([]);
    expectLoggedFailure(result);
  });
});

describe("given Storage.read as 'failsWithFileNotRead'", () => {
  const storage = storageBuilder.read('failsWithFileNotRead');

  test('[HI-T5-E] fails with InboxEventNotHandled after Storage.read retries are exhausted', async () => {
    const result = await makeHandleInboxScenario({ storage }).run();

    const fails = expectFailed(result.exit, { fails: [fileNotRead] });
    expect(fails[0]).toBeInstanceOf(InboxEventNotHandled);
    expect(result.storage.calls).toEqual([readCall, readCall, readCall, readCall]);
    expect(result.requestLedger.calls).toEqual([acknowledgeCall, failedCall]);
    expect(result.emailParser.calls).toEqual([]);
    expectLoggedFailure(result);
  });

  test('[HI-P-failed-not-recorded] logs a warning after four failed records of the failed status, and still fails', async () => {
    const result = await makeHandleInboxScenario({
      storage,
      requestLedger: requestLedgerBuilder.acknowledge('succeeds').record('failsWithRequestNotRecorded'),
    }).run();

    const fails = expectFailed(result.exit, { fails: [fileNotRead] });
    expect(fails[0]).toBeInstanceOf(InboxEventNotHandled);
    expect(result.requestLedger.calls).toEqual([acknowledgeCall, failedCall, failedCall, failedCall, failedCall]);
    expect(result.loggedWarnings(RequestNotRecorded)).toMatchObject([
      { requestID: requestID, progress: inboxEnded('failed'), reason: 'unavailable' },
    ]);
    expectLoggedFailure(result);
  });
});

describe("given Storage.read as 'succeedsAfterTwoSeconds'", () => {
  const storage = storageBuilder.read('succeedsAfterTwoSeconds');

  test('[HI-H2-interrupted] preserves interruption alone without deleting or logging', async () => {
    const run = makeHandleInboxScenario({ storage }).start();

    await run.adjust('1 second');
    await run.interrupt();
    const result = await run.done();

    expectFailed(result.exit, { interrupts: 1 });
    expect(result.storage.calls).toEqual([readCall]);
    expect(result.requestLedger.calls).toEqual([acknowledgeCall]);
    expect(result.emailParser.calls).toEqual([]);
    expect(result.loggedErrors()).toEqual([]);
  });
});

describe("given Storage.read as 'succeeds'", () => {
  const storage = storageBuilder.read('succeeds');

  test('[HI-T6-U] wraps the EmailParser.parse defect without deleting', async () => {
    const result = await makeHandleInboxScenario({ storage }).run();

    expect(result.storage.calls).toEqual([readCall]);
    expectWrappedUnimplemented(result.exit, EmailParser, 'parse');
    expect(result.emailParser.calls).toEqual([]);
    expectLoggedFailure(result);
  });

  describe("given EmailParser.parse as 'failsWithEmailNotParsed'", () => {
    const emailParser = emailParserBuilder.parse('failsWithEmailNotParsed');

    test('[HI-F-size] logs the size of the email, also for a rejected email', async () => {
      const result = await makeHandleInboxScenario({ storage: storage.delete('succeeds'), emailParser }).run();

      expectSucceeded(result.exit);
      // The mock email is the JSON of one lead: 117 bytes.
      expect(result.loggedInfos()).toContain(
        fileSizeLogMessage(requestID, { kind: 'email', key: command.key, bytes: 117 })
      );
    });

    test('[HI-T6-E1] logs EmailNotParsed, deletes the inbox object, and succeeds', async () => {
      const result = await makeHandleInboxScenario({ storage: storage.delete('succeeds'), emailParser }).run();

      expectSucceeded(result.exit);
      expect(result.loggedErrors()).toHaveLength(1);
      expect(result.loggedErrors(EmailNotParsed)).toMatchObject([{ reason: 'cannot parse' }]);
      expect(result.emailParser.calls).toHaveLength(1);
      expect(result.guard.calls).toEqual([]);
      expect(result.requestLedger.calls).toEqual([acknowledgeCall, rejectedCall]);
      expect(result.storage.calls).toEqual([readCall, deleteCall]);
    });
  });

  describe("given EmailParser.parse as 'succeedsWithoutAttachments' and Guard.authorize as 'succeeds'", () => {
    const emailParser = emailParserBuilder.parse('succeedsWithoutAttachments');
    const guard = guardBuilder.authorize('succeeds');

    describe("given Storage.delete as 'failsWithFileNotDeleted'", () => {
      const storageWithDelete = storage.delete('failsWithFileNotDeleted');

      test('[HI-T4-E] logs a warning after four failed deletes of the processed email and succeeds', async () => {
        const result = await makeHandleInboxScenario({ storage: storageWithDelete, emailParser, guard }).run();

        expectSucceeded(result.exit);
        expect(result.requestLedger.calls).toEqual([acknowledgeCall, attachmentsCall(0), processedCall]);
        expect(result.storage.calls).toEqual([readCall, deleteCall, deleteCall, deleteCall, deleteCall]);
        expect(result.loggedErrors()).toEqual([]);
        expect(result.loggedWarnings(FileNotDeleted)).toMatchObject([{ file: { bucket: 'inbox', key: command.key } }]);
      });
    });

    describe("given Storage.delete as 'succeeds'", () => {
      const storageWithDelete = storage.delete('succeeds');

      test('[HI-H1-empty] stores nothing, deletes the email, and succeeds', async () => {
        const result = await makeHandleInboxScenario({ storage: storageWithDelete, emailParser, guard }).run();

        expectSucceeded(result.exit);
        expect(result.storage.calls).toEqual([readCall, deleteCall]);
        expect(result.requestLedger.calls).toEqual([acknowledgeCall, attachmentsCall(0), processedCall]);
        expect(result.guard.calls).toEqual([authorizeCall]);
        expect(result.loggedErrors()).toEqual([]);
      });
    });
  });

  describe("given EmailParser.parse as 'succeedsWithTwoAttachments' and Guard.authorize as 'succeeds'", () => {
    const emailParser = emailParserBuilder.parse('succeedsWithTwoAttachments');
    const guard = guardBuilder.authorize('succeeds');

    describe("given Storage.storeOrSkip as 'failsWithFileNotStoredForBroken'", () => {
      const storageWithStore = storage.storeOrSkip('failsWithFileNotStoredForBroken');

      test('[HI-H1-one-of-two] stores both and fails with InboxEventNotHandled for the broken attachment', async () => {
        const result = await makeHandleInboxScenario({
          storage: storageWithStore,
          emailParser,
          guard,
        }).run();

        const fails = expectFailed(result.exit, {
          fails: [attachmentsNotStored(storedKey('02-broken'))],
        });
        expect(fails[0]).toBeInstanceOf(InboxEventNotHandled);
        expect(storedKeys(result.storage.calls)).toEqual([
          storedKey('01-lead'),
          storedKey('02-broken'),
          storedKey('02-broken'),
          storedKey('02-broken'),
          storedKey('02-broken'),
        ]);
        expect(result.requestLedger.calls).toEqual([acknowledgeCall, attachmentsCall(2), failedCall]);
        expectLoggedFailure(result);
      });
    });
  });

  describe("given EmailParser.parse as 'succeeds'", () => {
    const emailParser = emailParserBuilder.parse('succeeds');

    test('[HI-T7-U] wraps the Guard.authorize defect without storing or deleting', async () => {
      const result = await makeHandleInboxScenario({ storage, emailParser }).run();

      expect(result.emailParser.calls).toHaveLength(1);
      expect(storedKeys(result.storage.calls)).toEqual([]);
      expectWrappedUnimplemented(result.exit, Guard, 'authorize');
      expectLoggedFailure(result);
    });

    describe("given Guard.authorize as 'failsWithUnauthorized'", () => {
      const guard = guardBuilder.authorize('failsWithUnauthorized');

      describe("given Storage.delete as 'failsWithFileNotDeleted'", () => {
        const storageWithDelete = storage.delete('failsWithFileNotDeleted');

        test('[HI-T9-E] logs Unauthorized, retries FileNotDeleted, and succeeds', async () => {
          const result = await makeHandleInboxScenario({ storage: storageWithDelete, emailParser, guard }).run();

          expectSucceeded(result.exit);
          expect(result.loggedErrors(Unauthorized)).toHaveLength(1);
          expect(result.loggedErrors()).toHaveLength(1);
          expect(result.storage.calls).toEqual([readCall, deleteCall, deleteCall, deleteCall, deleteCall]);
          expect(result.loggedWarnings(FileNotDeleted)).toMatchObject([
            { file: { bucket: 'inbox', key: command.key } },
          ]);
        });
      });

      test('[HI-T7-E] logs Unauthorized, deletes the inbox object, and succeeds', async () => {
        const result = await makeHandleInboxScenario({
          storage: storage.delete('succeeds'),
          emailParser,
          guard,
        }).run();

        expectSucceeded(result.exit);
        expect(result.loggedErrors()).toHaveLength(1);
        expect(result.loggedErrors(Unauthorized)).toMatchObject([
          {
            senders: ['sender@example.com'],
            reason: 'unavailable',
            message: 'Unauthorized senders: sender@example.com',
          },
        ]);
        expect(result.guard.calls).toEqual([authorizeCall]);
        expect(result.requestLedger.calls).toEqual([acknowledgeCall, rejectedCall]);
        expect(result.storage.calls).toEqual([readCall, deleteCall]);
      });
    });

    describe("given Guard.authorize as 'succeeds'", () => {
      const guard = guardBuilder.authorize('succeeds');

      test('[HI-T8-U] wraps the Storage.storeOrSkip defect without deleting', async () => {
        const result = await makeHandleInboxScenario({
          storage,
          emailParser,
          guard,
        }).run();

        expect(result.guard.calls).toEqual([authorizeCall]);
        expectWrappedUnimplemented(result.exit, Storage, 'storeOrSkip');
        expect(result.storage.calls).toEqual([readCall]);
        expectLoggedFailure(result);
      });

      describe("given Storage.storeOrSkip as 'failsWithFileNotStored'", () => {
        const storageWithStore = storage.storeOrSkip('failsWithFileNotStored');

        test('[HI-H1-one-failure] fails with InboxEventNotHandled for the attachment', async () => {
          const result = await makeHandleInboxScenario({
            storage: storageWithStore,
            emailParser,
            guard,
          }).run();

          const fails = expectFailed(result.exit, {
            fails: [attachmentsNotStored(storedKey('01-lead'))],
          });
          expect(fails[0]).toBeInstanceOf(InboxEventNotHandled);
          expect(storedKeys(result.storage.calls)).toEqual([
            storedKey('01-lead'),
            storedKey('01-lead'),
            storedKey('01-lead'),
            storedKey('01-lead'),
          ]);
          expectLoggedFailure(result);
        });
      });

      describe("given Storage.storeOrSkip as 'skips'", () => {
        const storageWithStore = storage.storeOrSkip('skips').delete('succeeds');

        test('[HI-H1-skipped] keeps an attachment that an earlier run stored, then deletes the email', async () => {
          const result = await makeHandleInboxScenario({
            storage: storageWithStore,
            emailParser,
            guard,
          }).run();

          expectSucceeded(result.exit);
          expect(storedKeys(result.storage.calls)).toEqual([storedKey('01-lead')]);
          expect(result.storage.calls.at(-1)).toEqual(deleteCall);
          expect(result.loggedErrors()).toEqual([]);
        });
      });

      describe("given Storage.storeOrSkip as 'failsWithFileNotStoredOnce'", () => {
        const storageWithStore = storage.storeOrSkip('failsWithFileNotStoredOnce').delete('succeeds');

        test('[HI-H1-retried] retries a store that failed once, then deletes the email', async () => {
          const result = await makeHandleInboxScenario({
            storage: storageWithStore,
            emailParser,
            guard,
          }).run();

          expectSucceeded(result.exit);
          expect(storedKeys(result.storage.calls)).toEqual([storedKey('01-lead'), storedKey('01-lead')]);
          expect(result.storage.calls.at(-1)).toEqual(deleteCall);
          expect(result.loggedErrors()).toEqual([]);
        });
      });

      describe("given Storage.storeOrSkip as 'succeeds'", () => {
        const storageWithStore = storage.storeOrSkip('succeeds').delete('succeeds');

        test('[HI-OK] stores the attachment, deletes the email, and succeeds', async () => {
          const result = await makeHandleInboxScenario({
            storage: storageWithStore,
            emailParser,
            guard,
          }).run();

          expectSucceeded(result.exit);
          expect(result.requestLedger.calls).toEqual([acknowledgeCall, attachmentsCall(1), processedCall]);
          expect(result.storage.calls).toMatchObject([
            readCall,
            { method: 'storeOrSkip', params: [{ bucket: 'lead-sources', key: storedKey('01-lead') }] },
            deleteCall,
          ]);
          expect(result.loggedErrors()).toEqual([]);
        });

        test('[HI-P-not-recorded] logs a warning after four failed records of each change, and still succeeds', async () => {
          const result = await makeHandleInboxScenario({
            storage: storageWithStore,
            emailParser,
            guard,
            requestLedger: requestLedgerBuilder.acknowledge('succeeds').record('failsWithRequestNotRecorded'),
          }).run();

          expectSucceeded(result.exit);
          expect(result.requestLedger.calls).toEqual([
            acknowledgeCall,
            ...Array.from({ length: 4 }, () => attachmentsCall(1)),
            ...Array.from({ length: 4 }, () => processedCall),
          ]);
          expect(storedKeys(result.storage.calls)).toEqual([storedKey('01-lead')]);
          expect(result.storage.calls.at(-1)).toEqual(deleteCall);
          expect(result.loggedWarnings(RequestNotRecorded)).toMatchObject([
            { progress: attachmentsCounted(1) },
            { progress: inboxEnded('processed') },
          ]);
          expect(result.loggedErrors()).toEqual([]);
        });

        test('[HI-OK-received-at] takes the folder from receivedAt, so a second delivery writes the same keys', async () => {
          const scenario = makeHandleInboxScenario({ storage: storageWithStore, emailParser, guard });
          const redelivery = { ...command, receivedAt: new Date(2025, 11, 31, 23, 59) };

          const first = await scenario.run(redelivery);
          const second = await scenario.run(redelivery);

          for (const result of [first, second]) {
            expectSucceeded(result.exit);
            expect(storedKeys(result.storage.calls)).toEqual([`31-12-2025/23-50/${requestID}/01-lead`]);
            expect(result.storage.calls.at(-1)).toEqual(deleteCall);
          }
        });
      });
    });
  });
});

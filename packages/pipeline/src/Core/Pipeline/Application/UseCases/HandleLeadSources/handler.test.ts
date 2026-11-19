import { originOfSource } from '@leads/shared/domain/keys';
import {
  fileSizeLogMessage,
  type Outcome,
  type RequestProgress,
  sourceEnded,
  sourceFoundLeads,
  sourceStarted,
} from '@leads/shared/domain/request';
import { toIdempotencyKey } from '@leads/shared/domain/schemas';
import { File } from '@leads/shared/domain/types';
import { requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { RequestNotRecorded } from '@leads/shared/ports/RequestLedger';
import { unimplemented } from '@leads/shared/testing/variants';
import { Cause, type Context, Exit } from 'effect';
import { describe, expect, test } from 'vitest';

import { FileIsEmpty } from '#Core/Pipeline/Domain/Exceptions/FileIsEmpty';
import { UnknownLeadsSource } from '#Core/Pipeline/Domain/Exceptions/UnknownLeadsSource';
import {
  ExcelSheetNotParsed,
  ExcelSheetParser,
  NotAnExcelDocument,
  WorkbookHasNoSheets,
} from '#Core/Pipeline/Ports/ExcelSheetParser';
import { MessageNotPushed, Queue } from '#Core/Pipeline/Ports/Queue';
import { FileNotDeleted, FileNotRead } from '#Core/Pipeline/Ports/Storage';
import { excelSheetParserBuilder } from '#Infrastructure/Pipeline/ExcelSheetParser/mock/variants';
import { queueBuilder } from '#Infrastructure/Pipeline/Queue/mock/variants';
import { storageBuilder } from '#Infrastructure/Pipeline/Storage/mock/variants';

import {
  LeadBatchesNotStored,
  LeadSourceEventNotHandled,
  LeadSourceNotExtracted,
  NoValidLeadsExtracted,
} from './handler';
import { command, makeHandleLeadSourcesScenario, requestID } from './handler.test.helpers';

type ScenarioResult = Awaited<ReturnType<ReturnType<typeof makeHandleLeadSourcesScenario>['run']>>;

const readCall = { method: 'read', params: [command.bucket, command.key] };
const deleteCall = { method: 'delete', params: [command.bucket, command.key] };
const rejectedRowWarning = [{ index: 1, message: expect.stringContaining('Row is empty') }];

const recordCall = (progress: RequestProgress) => ({ method: 'record', params: [requestID, progress] });
const startCall = recordCall(sourceStarted());
const foundCall = (leads: number) => recordCall(sourceFoundLeads(leads));
const endCall = (outcome: Outcome, leadsNotPushed?: number) => recordCall(sourceEnded(outcome, leadsNotPushed));
const failingLedger = requestLedgerBuilder.record('failsWithRequestNotRecorded');

function expectSucceeded(exit: Exit.Exit<unknown, unknown>) {
  expect(exit).toEqual(Exit.succeed(undefined));
}

/** The handler fails with one LeadSourceEventNotHandled and logs it, because the DLQ message does not carry the reason. */
function wrappedReason(result: ScenarioResult) {
  if (!Exit.isFailure(result.exit)) throw new Error('Expected a failed Exit');
  expect(result.exit.cause.reasons).toHaveLength(1);
  const reason = result.exit.cause.reasons[0];
  if (reason === undefined || !Cause.isFailReason(reason)) throw new Error('Expected exactly one typed failure');
  expect(reason.error).toBeInstanceOf(LeadSourceEventNotHandled);
  if (!(reason.error instanceof LeadSourceEventNotHandled)) throw new Error('Expected LeadSourceEventNotHandled');
  expect(reason.error.command).toEqual(command);
  expect(result.loggedErrors()).toEqual([reason.error]);
  return reason.error.reason;
}

function expectWrappedUnimplemented(result: ScenarioResult, port: Context.Key<unknown, unknown>, method: string) {
  const reason = wrappedReason(result);
  expect(reason).toBeInstanceOf(Error);
  expect(reason).toMatchObject(unimplemented(port, method));
}

/** The handler logs a rejected source, deletes it, and succeeds, because a redrive cannot fix the source. */
function expectRejected<T extends Error>(result: ScenarioResult, errorClass: new (...args: never[]) => T) {
  expectSucceeded(result.exit);
  const [rejection] = result.loggedErrors(errorClass);
  expect(result.loggedErrors()).toEqual([rejection]);
  if (rejection === undefined) throw new Error('Expected one logged ' + errorClass.name);
  expect(rejection).toMatchObject({ bucket: command.bucket, key: command.key });
  return rejection;
}

function expectNotExtracted(result: ScenarioResult) {
  return expectRejected(result, LeadSourceNotExtracted).reason;
}

function queueMessage(name = 'Acme') {
  return {
    lead: {
      extraction_source: 'new_acquisition' as const,
      idempotencyKey: toIdempotencyKey('new_acquisition', { Name: name, Ort: 'Zürich' }),
      extracted: {
        name,
        companyAdditional: undefined,
        street: undefined,
        zip: undefined,
        city: 'Zürich',
        phone: undefined,
        mobile: undefined,
        uid: undefined,
        subjectNumber: undefined,
      },
      raw: { Name: name, Ort: 'Zürich' },
    },
    requestID: requestID,
  };
}

function expectPushes(result: ScenarioResult, names: readonly string[]) {
  const messages = result.queue.calls.flatMap((call) => call.params[0]);
  expect(messages.toSorted((a, b) => (a.lead.extracted.name ?? '').localeCompare(b.lead.extracted.name ?? ''))).toEqual(
    names.toSorted().map((name) => queueMessage(name))
  );
}

function expectNotPushed(result: ScenarioResult, failures: readonly MessageNotPushed[]) {
  const reason = wrappedReason(result);
  expect(reason).toBeInstanceOf(LeadBatchesNotStored);
  expect((reason as LeadBatchesNotStored).failures).toEqual(failures);
}

const notPushed = (name: string, reason: string) =>
  new MessageNotPushed({ requestID: requestID, lead: queueMessage(name).lead, reason });

describe("given Storage.read as 'failsWithFileNotRead'", () => {
  const storage = storageBuilder.read('failsWithFileNotRead');

  test('[HLS-T2-E] retries reading four times and fails with the wrapped FileNotRead', async () => {
    const result = await makeHandleLeadSourcesScenario({ storage }).run();

    const reason = wrappedReason(result);
    expect(reason).toBeInstanceOf(FileNotRead);
    expect(reason).toMatchObject({ bucket: command.bucket, key: command.key, reason: 'unavailable' });
    expect(result.storage.calls).toEqual([readCall, readCall, readCall, readCall]);
    expect(result.requestLedger.calls).toEqual([startCall, endCall('failed')]);
    expect(result.excelSheetParser.calls).toEqual([]);
    expect(result.queue.calls).toEqual([]);
    expect(result.loggedWarnings()).toEqual([]);
  });
});

describe("given Storage.read as 'succeedsWithEmptyBody'", () => {
  const storage = storageBuilder.read('succeedsWithEmptyBody');

  describe("given Storage.delete as 'failsWithFileNotDeleted'", () => {
    const failedDelete = storage.delete('failsWithFileNotDeleted');

    test('[HLS-T3-E] logs a warning after four failed deletes and succeeds', async () => {
      const result = await makeHandleLeadSourcesScenario({ storage: failedDelete }).run();

      expect(expectNotExtracted(result)).toBeInstanceOf(FileIsEmpty);
      expect(result.storage.calls).toEqual([readCall, deleteCall, deleteCall, deleteCall, deleteCall]);
      expect(result.loggedWarnings(FileNotDeleted)).toMatchObject([
        { file: { bucket: command.bucket, key: command.key }, reason: 'unavailable' },
      ]);
    });
  });

  test('[HLS-H1-empty-body] logs the extraction error and deletes the source', async () => {
    const result = await makeHandleLeadSourcesScenario({ storage: storage.delete('succeeds') }).run();

    const reason = expectNotExtracted(result);
    expect(reason).toBeInstanceOf(FileIsEmpty);
    expect(reason).toMatchObject({ service: 'HandleLeadSources', reason: command.key });
    expect(result.storage.calls).toEqual([readCall, deleteCall]);
    expect(result.requestLedger.calls).toEqual([startCall, endCall('rejected')]);
    expect(result.excelSheetParser.calls).toEqual([]);
    expect(result.queue.calls).toEqual([]);
    expect(result.loggedWarnings()).toEqual([]);
  });
});

describe("given Storage.read as 'succeedsAfterTwoSeconds'", () => {
  const storage = storageBuilder.read('succeedsAfterTwoSeconds');

  test('[HLS-H3-interrupted] preserves interruption alone without logging or deleting', async () => {
    const run = makeHandleLeadSourcesScenario({ storage }).start();

    await run.adjust('1 second');
    await run.interrupt();
    const result = await run.done();

    if (!Exit.isFailure(result.exit)) throw new Error('Expected an interrupted Exit');
    expect(result.exit.cause.reasons).toHaveLength(1);
    expect(Cause.hasInterruptsOnly(result.exit.cause)).toBe(true);
    expect(result.storage.calls).toEqual([readCall]);
    expect(result.requestLedger.calls).toEqual([startCall]);
    expect(result.excelSheetParser.calls).toEqual([]);
    expect(result.queue.calls).toEqual([]);
    expect(result.loggedErrors()).toEqual([]);
    expect(result.loggedWarnings()).toEqual([]);
  });
});

describe("given Storage.read as 'succeeds'", () => {
  const storage = storageBuilder.read('succeeds');
  /** A rejected source is deleted, so the rejection scenarios also need Storage.delete. */
  const rejectable = storage.delete('succeeds');

  test('[HLS-T4-U] wraps and logs the ExcelSheetParser.parse defect without deleting', async () => {
    const result = await makeHandleLeadSourcesScenario({ storage }).run();

    expectWrappedUnimplemented(result, ExcelSheetParser, 'parse');
    expect(result.storage.calls).toEqual([readCall]);
    expect(result.queue.calls).toEqual([]);
    expect(result.loggedWarnings()).toEqual([]);
  });

  describe.each([
    {
      id: 'HLS-T4-E1',
      variant: 'failsWithNotAnExcelDocument',
      errorClass: NotAnExcelDocument,
      errorFields: {},
      reasonMessage: 'Invalid file type. Please provide an .xlsx file',
    },
    {
      id: 'HLS-T4-E2',
      variant: 'failsWithWorkbookHasNoSheets',
      errorClass: WorkbookHasNoSheets,
      errorFields: {},
      reasonMessage: 'Workbook has no sheets',
    },
    {
      id: 'HLS-T4-E3',
      variant: 'failsWithExcelSheetNotParsed',
      errorClass: ExcelSheetNotParsed,
      errorFields: { reason: 'corrupted' },
      reasonMessage: 'Excel sheet cannot be parsed',
    },
  ] as const)(
    "given ExcelSheetParser.parse as '$variant'",
    ({ id, variant, errorClass, errorFields, reasonMessage }) => {
      const excelSheetParser = excelSheetParserBuilder.parse(variant);

      test('[' + id + '] logs the parser error and deletes the source', async () => {
        const result = await makeHandleLeadSourcesScenario({ storage: rejectable, excelSheetParser }).run();

        const rejection = expectRejected(result, LeadSourceNotExtracted);
        expect(rejection.reason).toBeInstanceOf(errorClass);
        expect(rejection.reason).toMatchObject(errorFields);
        expect(rejection.message).toBe(
          'Lead source not extracted from bucket: ' +
            command.bucket +
            ' with key: ' +
            command.key +
            ' due to: ' +
            reasonMessage
        );
        expect(result.excelSheetParser.calls).toHaveLength(1);
        expect(String(result.excelSheetParser.calls[0]?.params[0])).toContain('Acme');
        expect(result.storage.calls).toEqual([readCall, deleteCall]);
        expect(result.requestLedger.calls).toEqual([startCall, endCall('rejected')]);
        expect(result.queue.calls).toEqual([]);
        expect(result.loggedWarnings()).toEqual([]);
      });
    }
  );

  describe("given ExcelSheetParser.parse as 'succeedsWithUnknownHeader'", () => {
    const excelSheetParser = excelSheetParserBuilder.parse('succeedsWithUnknownHeader');

    test('[HLS-H1-unknown-source] logs the unknown header and deletes the source', async () => {
      const result = await makeHandleLeadSourcesScenario({ storage: rejectable, excelSheetParser }).run();

      const reason = expectNotExtracted(result);
      expect(reason).toBeInstanceOf(UnknownLeadsSource);
      expect(reason).toMatchObject({ header: ['Unknown'] });
      expect(result.storage.calls).toEqual([readCall, deleteCall]);
      expect(result.queue.calls).toEqual([]);
      expect(result.loggedWarnings()).toEqual([]);
    });
  });

  describe("given ExcelSheetParser.parse as 'succeedsWithOnlyRejectedRows'", () => {
    const excelSheetParser = excelSheetParserBuilder.parse('succeedsWithOnlyRejectedRows');

    test('[HLS-H1-all-rejected] warns about every rejected row, logs NoValidLeadsExtracted, and deletes the source', async () => {
      const result = await makeHandleLeadSourcesScenario({ storage: rejectable, excelSheetParser }).run();

      const rejection = expectRejected(result, NoValidLeadsExtracted);
      expect(rejection.message).toBe(
        'No valid leads extracted from bucket: ' + command.bucket + ' with key: ' + command.key
      );
      expect(result.loggedWarnings()).toMatchObject([
        [
          { index: 0, message: expect.stringContaining('Row is empty') },
          { index: 1, message: expect.stringContaining('Row is empty') },
        ],
      ]);
      expect(result.storage.calls).toEqual([readCall, deleteCall]);
      expect(result.requestLedger.calls).toEqual([startCall, endCall('rejected')]);
      expect(result.queue.calls).toEqual([]);
    });
  });

  describe("given ExcelSheetParser.parse as 'succeedsWithRejectedRow'", () => {
    const excelSheetParser = excelSheetParserBuilder.parse('succeedsWithRejectedRow');
    const parsed = { storage, excelSheetParser };

    test('[HLS-T5-U] warns about the rejected row and wraps the Queue.pushBatch defect', async () => {
      const result = await makeHandleLeadSourcesScenario(parsed).run();

      expectWrappedUnimplemented(result, Queue, 'pushBatch');
      expect(result.loggedWarnings()).toMatchObject([rejectedRowWarning]);
      expect(result.storage.calls).toEqual([readCall]);
      expect(result.excelSheetParser.calls).toHaveLength(1);
      expect(result.queue.calls).toEqual([]);
    });

    describe("given Queue.pushBatch as 'failsWithMessageBatchNotPushed'", () => {
      const queue = queueBuilder.pushBatch('failsWithMessageBatchNotPushed');

      test('[HLS-T5-E] fails with the wrapped LeadBatchesNotStored after four failed pushes, without deleting', async () => {
        const result = await makeHandleLeadSourcesScenario({ ...parsed, queue }).run();

        expectNotPushed(result, [notPushed('Acme', 'unavailable')]);
        expectPushes(result, ['Acme', 'Acme', 'Acme', 'Acme']);
        expect(result.loggedWarnings()).toMatchObject([rejectedRowWarning]);
        expect(result.storage.calls).toEqual([readCall]);
        expect(result.requestLedger.calls).toEqual([startCall, foundCall(1), endCall('failed', 1)]);
      });

      test('[HLS-P-failed-not-recorded] logs a warning after four failed records of each change, and still fails', async () => {
        const result = await makeHandleLeadSourcesScenario({
          ...parsed,
          queue,
          requestLedger: failingLedger,
        }).run();

        expectNotPushed(result, [notPushed('Acme', 'unavailable')]);
        expect(result.requestLedger.calls).toEqual(
          [startCall, foundCall(1), endCall('failed', 1)].flatMap((call) => [call, call, call, call])
        );
        expect(result.loggedWarnings(RequestNotRecorded)).toMatchObject([
          { requestID: requestID, progress: sourceStarted(), reason: 'unavailable' },
          { progress: sourceFoundLeads(1) },
          { progress: sourceEnded('failed', 1) },
        ]);
      });
    });

    describe("given Queue.pushBatch as 'succeeds'", () => {
      const queue = queueBuilder.pushBatch('succeeds');
      const pushed = { ...parsed, queue };

      describe("given Storage.delete as 'failsWithFileNotDeleted'", () => {
        const failedDelete = { ...pushed, storage: storage.delete('failsWithFileNotDeleted') };

        test('[HLS-T7-E] logs a warning after four failed deletes of the processed source and succeeds', async () => {
          const result = await makeHandleLeadSourcesScenario(failedDelete).run();

          expectSucceeded(result.exit);
          expect(result.requestLedger.calls).toEqual([startCall, foundCall(1), endCall('processed')]);
          expect(result.storage.calls).toEqual([readCall, deleteCall, deleteCall, deleteCall, deleteCall]);
          expect(result.loggedErrors()).toEqual([]);
          expect(result.loggedWarnings(FileNotDeleted)).toMatchObject([
            { file: { bucket: command.bucket, key: command.key }, reason: 'unavailable' },
          ]);
        });
      });

      describe("given Storage.delete as 'succeeds'", () => {
        test('[HLS-H1-rejected] queues only the valid lead and deletes the source', async () => {
          const result = await makeHandleLeadSourcesScenario({ ...pushed, storage: rejectable }).run();

          expectSucceeded(result.exit);
          expectPushes(result, ['Acme']);
          expect(result.loggedWarnings()).toMatchObject([rejectedRowWarning]);
          expect(result.loggedErrors()).toEqual([]);
          expect(result.storage.calls).toEqual([readCall, deleteCall]);
        });
      });
    });
  });

  // Storage.delete now succeeds in the later scenarios that end.
  describe("given ExcelSheetParser.parse as 'succeedsWithTwoLeads'", () => {
    const excelSheetParser = excelSheetParserBuilder.parse('succeedsWithTwoLeads');
    const parsed = { storage: rejectable, excelSheetParser };

    describe("given Queue.pushBatch as 'failsWithMessageBatchNotPushedForBrokenLead'", () => {
      const queue = queueBuilder.pushBatch('failsWithMessageBatchNotPushedForBrokenLead');

      test('[HLS-H2-one-of-two] retries only Broken and fails with its wrapped push failure, without deleting', async () => {
        const result = await makeHandleLeadSourcesScenario({ ...parsed, queue }).run();

        expectNotPushed(result, [notPushed('Broken', 'Broken')]);
        expectPushes(result, ['Acme', 'Broken', 'Broken', 'Broken', 'Broken']);
        expect(result.requestLedger.calls).toEqual([startCall, foundCall(2), endCall('failed', 1)]);
        expect(result.loggedWarnings()).toEqual([]);
        expect(result.storage.calls).toEqual([readCall]);
      });
    });

    describe("given Queue.pushBatch as 'succeedsAfterTwoMessageBatchNotPushedFailures'", () => {
      const queue = queueBuilder.pushBatch('succeedsAfterTwoMessageBatchNotPushedFailures');

      test('[HLS-H4-recovered] retries Broken twice and deletes the source', async () => {
        const result = await makeHandleLeadSourcesScenario({ ...parsed, queue }).run();

        expectSucceeded(result.exit);
        expectPushes(result, ['Acme', 'Broken', 'Broken', 'Broken']);
        expect(result.loggedWarnings()).toEqual([]);
        expect(result.loggedErrors()).toEqual([]);
        expect(result.storage.calls).toEqual([readCall, deleteCall]);
      });
    });
  });

  describe("given ExcelSheetParser.parse as 'succeedsWithElevenLeads'", () => {
    const excelSheetParser = excelSheetParserBuilder.parse('succeedsWithElevenLeads');

    describe("given Queue.pushBatch as 'succeeds'", () => {
      const queue = queueBuilder.pushBatch('succeeds');

      test('[HLS-H2-batches] pushes the leads in batches of ten and deletes the source', async () => {
        const result = await makeHandleLeadSourcesScenario({
          storage: rejectable,
          excelSheetParser,
          queue,
        }).run();

        expectSucceeded(result.exit);
        expect(result.queue.calls.map((call) => call.params[0].length).toSorted((a, b) => a - b)).toEqual([1, 10]);
        expectPushes(
          result,
          Array.from({ length: 11 }, (_, index) => `Lead ${index}`)
        );
        expect(result.storage.calls).toEqual([readCall, deleteCall]);
        expect(result.loggedWarnings()).toEqual([]);
        expect(result.loggedErrors()).toEqual([]);
      });
    });
  });

  describe("given ExcelSheetParser.parse as 'succeeds'", () => {
    const excelSheetParser = excelSheetParserBuilder.parse('succeeds');

    describe("given Queue.pushBatch as 'succeeds'", () => {
      const queue = queueBuilder.pushBatch('succeeds');
      const complete = { storage: rejectable, excelSheetParser, queue };

      test('[HLS-OK] queues the complete lead message, deletes the source, and succeeds', async () => {
        const result = await makeHandleLeadSourcesScenario(complete).run();

        expectSucceeded(result.exit);
        expect(result.queue.calls).toEqual([{ method: 'pushBatch', params: [[queueMessage()]] }]);
        expect(result.requestLedger.calls).toEqual([startCall, foundCall(1), endCall('processed')]);
        expect(result.excelSheetParser.calls).toHaveLength(1);
        expect(String(result.excelSheetParser.calls[0]?.params[0])).toContain('Acme');
        expect(result.storage.calls).toEqual([readCall, deleteCall]);
        expect(result.loggedWarnings()).toEqual([]);
        expect(result.loggedErrors()).toEqual([]);
      });

      test('[HLS-F-size] logs the size of the source', async () => {
        const result = await makeHandleLeadSourcesScenario(complete).run();

        expectSucceeded(result.exit);
        // The mock workbook is the JSON of one lead: 117 bytes.
        expect(result.loggedInfos()).toContain(
          fileSizeLogMessage(requestID, { kind: 'source', key: command.key, bytes: 117 })
        );
      });

      test('[HLS-F-standalone-size] logs the size of a standalone source under its own request', async () => {
        const upload = { ...command, key: 'received/leads.xlsx' };
        const { requestID: standalone } = originOfSource(File.make({ bucket: upload.bucket, key: upload.key }));

        const result = await makeHandleLeadSourcesScenario(complete).run(upload);

        expectSucceeded(result.exit);
        expect(result.loggedInfos()).toContain(
          fileSizeLogMessage(standalone, { kind: 'source', key: upload.key, bytes: 117 })
        );
      });

      test('[HLS-P-not-recorded] logs a warning after four failed records of each change, and still succeeds', async () => {
        const result = await makeHandleLeadSourcesScenario({ ...complete, requestLedger: failingLedger }).run();

        expectSucceeded(result.exit);
        expect(result.requestLedger.calls).toEqual(
          [startCall, foundCall(1), endCall('processed')].flatMap((call) => [call, call, call, call])
        );
        expect(result.queue.calls).toEqual([{ method: 'pushBatch', params: [[queueMessage()]] }]);
        expect(result.storage.calls).toEqual([readCall, deleteCall]);
        expect(result.loggedWarnings(RequestNotRecorded)).toMatchObject([
          { progress: sourceStarted() },
          { progress: sourceFoundLeads(1) },
          { progress: sourceEnded('processed') },
        ]);
        expect(result.loggedWarnings()).toHaveLength(3);
        expect(result.loggedErrors()).toEqual([]);
      });

      test('[HLS-K-standalone] makes a source outside the folder of an email a request of its own, and logs a warning', async () => {
        const upload = { ...command, key: 'received/leads.xlsx' };
        const { requestID: standalone } = originOfSource(File.make({ bucket: upload.bucket, key: upload.key }));

        const result = await makeHandleLeadSourcesScenario(complete).run(upload);

        expectSucceeded(result.exit);
        expect(standalone).not.toBe(requestID);
        expect(result.requestLedger.calls.map((call) => call.params[0])).toEqual([standalone, standalone, standalone]);
        expect(result.queue.calls).toEqual([
          { method: 'pushBatch', params: [[{ ...queueMessage(), requestID: standalone }]] },
        ]);
        expect(result.storage.calls).toEqual([
          { method: 'read', params: [upload.bucket, upload.key] },
          { method: 'delete', params: [upload.bucket, upload.key] },
        ]);
        expect(result.loggedWarnings()).toEqual([
          `Lead source from ${upload.bucket} with key: ${upload.key} is not in the folder of an email, so it is request ${standalone}`,
        ]);
        expect(result.loggedErrors()).toEqual([]);
      });
    });
  });
});

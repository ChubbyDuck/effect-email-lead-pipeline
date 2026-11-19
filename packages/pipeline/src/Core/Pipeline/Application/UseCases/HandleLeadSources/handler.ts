import { originOfSource } from '@leads/shared/domain/keys';
import { QueueBatchSize } from '@leads/shared/domain/queueLimits';
import { sourceEnded, sourceFoundLeads, sourceStarted } from '@leads/shared/domain/request';
import { File } from '@leads/shared/domain/types';
import { withReason } from '@leads/shared/utils';
import { Array, Data, Effect, Ref } from 'effect';

import { AppConfig } from '#Core/Pipeline/Application/config';
import { recordFileSize } from '#Core/Pipeline/Application/fileSize';
import { withHandlerOutcome } from '#Core/Pipeline/Application/outcome';
import { makeProgressRecorder } from '#Core/Pipeline/Application/progress';
import { retryPolicy } from '#Core/Pipeline/Application/retry';
import type { QueuedLead } from '#Core/Pipeline/Domain/queuedLead';
import { readBody } from '#Core/Pipeline/Domain/Transformations/file';
import { toLeadsAndRejectionsFromSheet } from '#Core/Pipeline/Domain/Transformations/leadSources';
import { ExcelSheetParser } from '#Core/Pipeline/Ports/ExcelSheetParser';
import type { MessageNotPushed } from '#Core/Pipeline/Ports/Queue';
import { Queue } from '#Core/Pipeline/Ports/Queue';
import { Storage } from '#Core/Pipeline/Ports/Storage';

import type { Command } from './command';

export class LeadSourceNotExtracted extends Data.TaggedError('LeadSourceNotExtracted')<{
  readonly bucket: string;
  readonly key: string;
  readonly reason: unknown;
}> {
  override get message(): string {
    return this.reason instanceof Error
      ? `Lead source not extracted from bucket: ${this.bucket} with key: ${this.key} due to: ${this.reason.message}`
      : `Lead source not extracted from bucket: ${this.bucket} with key: ${this.key}`;
  }
}

export class NoValidLeadsExtracted extends Data.TaggedError('NoValidLeadsExtracted')<{
  readonly bucket: string;
  readonly key: string;
}> {
  override get message(): string {
    return `No valid leads extracted from bucket: ${this.bucket} with key: ${this.key}`;
  }
}

export class LeadBatchesNotStored extends Data.TaggedError('LeadBatchesNotStored')<{
  readonly failures: MessageNotPushed[];
}> {
  override get message(): string {
    return `Lead batches not stored: ${this.failures.map((failure) => failure.message).join(', ')}`;
  }
}

export class LeadSourceEventNotHandled extends Data.TaggedError('LeadSourceNotHandled')<{
  readonly command: Command;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(
      `Lead Source from ${this.command.bucket} with key: ${this.command.key} is not handled`,
      this.reason
    );
  }
}

export function handler(command: Command) {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const storage = yield* Storage;
    const queue = yield* Queue;
    const excelSheetParser = yield* ExcelSheetParser;
    const progress = yield* makeProgressRecorder;
    // The key of the workbook gives the request, so the source counts in the entry of the email that gave it.
    const origin = originOfSource(File.make({ bucket: command.bucket, key: command.key }));
    const { requestID } = origin;

    // A source outside the folder of an email, such as a manual upload, gets an entry of its own, so the log tells why.
    if (origin._tag === 'Standalone') {
      yield* Effect.logWarning(
        `Lead source from ${command.bucket} with key: ${command.key} is not in the folder of an email, so it is request ${requestID}`
      );
    }

    const work = Effect.gen(function* () {
      yield* progress.record(requestID, sourceStarted());
      const file = yield* storage.read(command.bucket, command.key).pipe(Effect.retry(retryPolicy(config)));
      // The source handler records the source, not the inbox, so a standalone source also has a size.
      yield* recordFileSize(requestID, 'source', file);
      const { leads, leadRejections } = yield* Effect.gen(function* () {
        const body = yield* readBody(file, 'HandleLeadSources');
        const sheet = yield* excelSheetParser.parse(body);
        return yield* toLeadsAndRejectionsFromSheet(sheet);
      }).pipe(Effect.mapError((reason) => new LeadSourceNotExtracted({ bucket: file.bucket, key: file.key, reason })));
      if (leadRejections.length > 0) {
        yield* Effect.logWarning(leadRejections.map(({ index, error }) => ({ index, message: error.message })));
      }
      if (leads.length === 0) {
        return yield* new NoValidLeadsExtracted({ bucket: file.bucket, key: file.key });
      }
      // The leads are counted before the first push, so a lead handler never ends a lead that the request does not count.
      yield* progress.record(requestID, sourceFoundLeads(leads.length));
      // Each retry pushes only the messages that the queue did not accept, so a retry does not duplicate pushed leads.
      const pushBatch = (messages: readonly QueuedLead[]) =>
        Effect.gen(function* () {
          const pending = yield* Ref.make(messages);
          yield* Ref.get(pending).pipe(
            Effect.andThen(queue.pushBatch),
            Effect.tapError((error) =>
              Ref.set(
                pending,
                error.failures.map(({ lead, requestID }) => ({ lead, requestID }))
              )
            ),
            Effect.retry(retryPolicy(config))
          );
        });
      const batches = Array.chunksOf(
        leads.map((lead) => ({ lead, requestID })),
        QueueBatchSize
      );
      yield* Effect.partition(batches, pushBatch, { concurrency: config.leadSourcesInternalConcurrency }).pipe(
        Effect.andThen(([, batchFailures]) => {
          const failures = batchFailures.flatMap((error) => error.failures);
          if (failures.length > 0) return Effect.fail(new LeadBatchesNotStored({ failures }));
          return Effect.void;
        })
      );
    });

    // The source is processed when every lead is pushed. A redrive cannot extract leads from the same workbook.
    // A redrive of a failed source pushes every lead again, but the order repository stores each idempotency key once.
    yield* withHandlerOutcome(work, {
      requestID,
      file: command,
      rejections: ['LeadSourceNotExtracted', 'NoValidLeadsExtracted'],
      // The leads that the queue did not take go to no lead handler, so they are failed leads of the request.
      ended: (outcome, reason) =>
        sourceEnded(outcome, reason instanceof LeadBatchesNotStored ? reason.failures.length : 0),
      notHandled: (reason) => new LeadSourceEventNotHandled({ command, reason }),
    });
  });
}

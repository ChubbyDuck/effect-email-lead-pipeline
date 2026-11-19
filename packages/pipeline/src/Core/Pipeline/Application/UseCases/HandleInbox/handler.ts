import { requestFolderOf, requestIDOfEmail } from '@leads/shared/domain/keys';
import { attachmentsCounted, inboxEnded, pendingRequest } from '@leads/shared/domain/request';
import { File } from '@leads/shared/domain/types';
import { RequestLedger } from '@leads/shared/ports/RequestLedger';
import { withReason } from '@leads/shared/utils';
import { Data, Effect } from 'effect';

import { AppConfig } from '#Core/Pipeline/Application/config';
import { recordFileSize } from '#Core/Pipeline/Application/fileSize';
import { withHandlerOutcome } from '#Core/Pipeline/Application/outcome';
import { makeProgressRecorder } from '#Core/Pipeline/Application/progress';
import { retryPolicy } from '#Core/Pipeline/Application/retry';
import { toSourceFile } from '#Core/Pipeline/Domain/Transformations/file';
import { EmailParser } from '#Core/Pipeline/Ports/EmailParser';
import { Guard } from '#Core/Pipeline/Ports/Guard';
import type { FileNotStored } from '#Core/Pipeline/Ports/Storage';
import { Storage } from '#Core/Pipeline/Ports/Storage';

import type { Command } from './command';

class AttachmentsNotStored extends Data.TaggedError('AttachmentsNotStored')<{
  readonly failures: FileNotStored[];
}> {
  override get message(): string {
    return `Attachments not stored: ${this.failures.map((failure) => failure.message).join(', ')}`;
  }
}

export class InboxEventNotHandled extends Data.TaggedError('InboxEventNotHandled')<{
  readonly command: Command;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(
      `Inbox event from ${this.command.bucket} with key: ${this.command.key} is not handled`,
      this.reason
    );
  }
}

export function handler(command: Command) {
  return Effect.gen(function* () {
    const config = yield* AppConfig;
    const storage = yield* Storage;
    const emailParser = yield* EmailParser;
    const guard = yield* Guard;
    const ledger = yield* RequestLedger;
    const progress = yield* makeProgressRecorder;
    // The key of the email gives the request, so a second delivery of the same email writes the same keys.
    const requestID = requestIDOfEmail(File.make({ bucket: command.bucket, key: command.key }));
    const folder = requestFolderOf(command.receivedAt, requestID);

    const work = Effect.gen(function* () {
      // The acknowledgement comes first, so every email that reaches the handler has a status, also one that fails later.
      yield* ledger.acknowledge(pendingRequest(requestID, command.receivedAt)).pipe(Effect.retry(retryPolicy(config)));

      const file = yield* storage.read(command.bucket, command.key).pipe(Effect.retry(retryPolicy(config)));
      // The size comes before the parse, so a rejected email also has a size.
      yield* recordFileSize(requestID, 'email', file);

      const email = yield* emailParser.parse(file);

      // A rejected email is deleted, so a forged or unauthenticated sender creates no order.
      yield* guard.authorize(email);

      // Only an authorized email gives sources, so the count is the number of sources to expect.
      yield* progress.record(requestID, attachmentsCounted(email.attachments.length));

      // A key that an earlier run already stored is skipped, so a redrive or a duplicate S3 event sends no second event.
      yield* Effect.partition(
        email.attachments,
        (attachment, index) =>
          storage
            .storeOrSkip(toSourceFile(config.leadSourcesBucketName, folder, index, attachment))
            .pipe(Effect.retry(retryPolicy(config))),
        { concurrency: config.inboxInternalConcurrency }
      ).pipe(
        Effect.andThen(([, failures]) => {
          if (failures.length > 0) return Effect.fail(new AttachmentsNotStored({ failures }));
          return Effect.void;
        })
      );
    });

    // The email is processed when it gave all its sources. A redrive cannot parse or authorize the same email again.
    return yield* withHandlerOutcome(work, {
      requestID,
      file: command,
      rejections: ['EmailNotParsed', 'Unauthorized'],
      ended: inboxEnded,
      notHandled: (reason) => new InboxEventNotHandled({ command, reason }),
    });
  });
}

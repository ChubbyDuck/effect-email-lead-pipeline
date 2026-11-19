import type { Command } from '@leads/pipeline/application/HandleInbox/command';
import { handler as handleInbox } from '@leads/pipeline/application/HandleInbox/handler';
import type { Context, SQSEvent } from 'aws-lambda';
import { Effect } from 'effect';

import { releaseFailedRecords } from './deadLetter';
import { fileFromRecord, receivedAtFromRecord } from './s3Event';
import { LambdaServicesLive } from './services';
import { withLambdaShutdown } from './shutdown';
import { recordsFromMessage } from './sqsEvent';

export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
  if (!Array.isArray(event.Records) || event.Records.length === 0) {
    throw new Error('SQS event has no records');
  }
  try {
    await withLambdaShutdown(context, async (signal) => {
      for (const message of event.Records) {
        for (const record of recordsFromMessage(message)) {
          const file = fileFromRecord(record);
          const command: Command = {
            bucket: file.bucket,
            key: file.key,
            receivedAt: receivedAtFromRecord(record),
            functionName: context.functionName,
          };
          await Effect.runPromise(handleInbox(command).pipe(Effect.provide(LambdaServicesLive)), { signal });
        }
      }
    });
  } catch (error) {
    await releaseFailedRecords(event.Records);
    throw error;
  }
};

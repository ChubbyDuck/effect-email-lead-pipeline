import type { Command } from '@leads/pipeline/application/HandleLeadSources/command';
import { handler as handleLeadSources } from '@leads/pipeline/application/HandleLeadSources/handler';
import type { Context, SQSEvent } from 'aws-lambda';
import { Effect } from 'effect';

import { releaseFailedRecords } from './deadLetter';
import { LeadSourcesServicesLive } from './leadSourcesServices';
import { fileFromRecord } from './s3Event';
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
            functionName: context.functionName,
          };
          await Effect.runPromise(handleLeadSources(command).pipe(Effect.provide(LeadSourcesServicesLive)), { signal });
        }
      }
    });
  } catch (error) {
    await releaseFailedRecords(event.Records);
    throw error;
  }
};

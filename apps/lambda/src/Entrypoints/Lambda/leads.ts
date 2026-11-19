import type { Command } from '@leads/pipeline/application/HandleLead/command';
import { handler as handleLead, type LeadNotHandled } from '@leads/pipeline/application/HandleLead/handler';
import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { Effect } from 'effect';

import { releaseFailedRecords } from './deadLetter';
import { LambdaServicesLive } from './services';
import { withLambdaShutdown } from './shutdown';

export const handler = async (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  if (!Array.isArray(event.Records) || event.Records.length === 0) {
    throw new Error('SQS event has no records');
  }
  const command: Command = {
    records: event.Records.map(({ messageId, body }) => ({ messageId, body })),
    functionName: context.functionName,
    source: `${context.invokedFunctionArn}/${context.functionName}:${context.functionVersion}`,
  };
  let notHandled: readonly LeadNotHandled[];
  try {
    notHandled = await withLambdaShutdown(context, (signal) =>
      Effect.runPromise(handleLead(command).pipe(Effect.provide(LambdaServicesLive)), { signal })
    );
  } catch (error) {
    await releaseFailedRecords(event.Records);
    throw error;
  }
  const failed = new Set(notHandled.map(({ messageId }) => messageId));
  await releaseFailedRecords(event.Records.filter(({ messageId }) => failed.has(messageId)));
  return {
    batchItemFailures: notHandled.map(({ messageId }) => ({ itemIdentifier: messageId })),
  };
};

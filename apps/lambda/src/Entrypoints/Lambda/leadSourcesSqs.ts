import { SQSClient } from '@aws-sdk/client-sqs';
import { LeadSourcesInternalConcurrency } from '@leads/pipeline/settings';
import { Effect } from 'effect';

/** Sockets of the leads SQS client: one per batch send, so that many sends really run at once. */
export const leadSourcesSqsSockets = Effect.runSync(LeadSourcesInternalConcurrency);

export const makeLeadSourcesSqsClient = (maxSockets: number, endpoint?: string) =>
  new SQSClient({
    ...(endpoint === undefined ? {} : { endpoint, useQueueUrlAsEndpoint: false }),
    requestHandler: { httpAgent: { maxSockets }, httpsAgent: { maxSockets } },
  });

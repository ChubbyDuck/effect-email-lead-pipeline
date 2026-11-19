import { type DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { Lead } from '@leads/shared/domain/types';
import { isAuthenticationFailure, nameOf } from '@leads/shared/infrastructure/awsErrors';
import { Clock, Config, Effect, Layer } from 'effect';

import {
  AuthenticationFailed,
  OrderRepository,
  OrderStoreFailed,
  OrderStoreTimedOut,
} from '#Core/Pipeline/Ports/OrderRepository';

/** DynamoDB did not take the write in time. The SDK retries throttling first, so these come after its own retries. */
const timeoutErrors = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ThrottlingException',
  'ProvisionedThroughputExceededException',
  'RequestLimitExceeded',
]);

export const toStoreError = (reason: unknown) => {
  const name = nameOf(reason);
  if (isAuthenticationFailure(reason)) return new AuthenticationFailed({ reason });
  if (name !== undefined && timeoutErrors.has(name)) return new OrderStoreTimedOut({ reason });
  return new OrderStoreFailed({ reason });
};

/** The time of storage, from the Effect clock, as an ISO string because DynamoDB has no date type. */
const storageTime = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()));

/**
 * The item is the lead as the leads queue carries it: JSON, with dates as ISO strings. It also has `storedAt`, the
 * time of storage as an ISO string, which belongs to the stored order only.
 */
const toItem = (lead: Lead, storedAt: string): Record<string, unknown> => ({
  ...JSON.parse(JSON.stringify(lead)),
  storedAt,
});

/**
 * Stores each lead as one item, keyed by its idempotency key. The put is conditional, so a lead that is already
 * stored stays as it is with its first `storedAt`, and a redrive or a resent workbook succeeds without a second order.
 */
export const makeOrderRepositoryLive = (dynamo: DynamoDBDocumentClient) =>
  Layer.effect(
    OrderRepository,
    Effect.gen(function* () {
      const tableName = yield* Config.String('ORDERS_TABLE_NAME');

      return {
        store: (lead) =>
          storageTime.pipe(
            Effect.andThen((storedAt) =>
              Effect.tryPromise({
                try: (abortSignal) =>
                  dynamo.send(
                    new PutCommand({
                      TableName: tableName,
                      Item: toItem(lead, storedAt),
                      ConditionExpression: 'attribute_not_exists(idempotencyKey)',
                    }),
                    { abortSignal }
                  ),
                catch: toStoreError,
              })
            ),
            Effect.asVoid,
            Effect.catchIf(
              ({ reason }) => nameOf(reason) === 'ConditionalCheckFailedException',
              () => Effect.void
            )
          ),
      };
    })
  );

import { type DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { Lead } from '@leads/shared/domain/types';
import { isAuthenticationFailure } from '@leads/shared/infrastructure/awsErrors';
import { Clock, Config, Effect, Layer, Schema } from 'effect';

import type { Order } from '#Core/Orders/Domain/order';
import { OrderReader, OrdersNotRead } from '#Core/Orders/Ports/OrderReader';

const decodeLead = Schema.decodeUnknownEffect(Lead);

/**
 * An item is the lead as JSON, and `storedAt` apart from it, because the time belongs to the stored order only. An
 * item that the order repository stored before it wrote the time has no `storedAt`.
 */
const toOrder = (item: Record<string, unknown>): Effect.Effect<Order, OrdersNotRead> => {
  const { storedAt, ...lead } = item;
  return decodeLead(lead).pipe(
    Effect.map((decoded) => ({ lead: decoded, storedAt: typeof storedAt === 'string' ? storedAt : undefined })),
    Effect.mapError((reason) => new OrdersNotRead({ reason, authentication: false, key: String(item.idempotencyKey) }))
  );
};

/**
 * Reads the Orders table with a scan, because the table has only its key and no index. A scan reads every item, so
 * its cost grows with the table. It is enough up to about ten thousand orders.
 */
export const makeOrderReaderLive = (dynamo: DynamoDBDocumentClient) =>
  Layer.effect(
    OrderReader,
    Effect.gen(function* () {
      const tableName = yield* Config.String('ORDERS_TABLE_NAME');

      return {
        all: Effect.gen(function* () {
          const readAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          const items: Record<string, unknown>[] = [];
          let startKey: Record<string, unknown> | undefined;
          do {
            const page = yield* Effect.tryPromise({
              try: (abortSignal) =>
                dynamo.send(
                  new ScanCommand({
                    TableName: tableName,
                    ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
                  }),
                  { abortSignal }
                ),
              catch: (reason) => new OrdersNotRead({ reason, authentication: isAuthenticationFailure(reason) }),
            });
            items.push(...(page.Items ?? []));
            startKey = page.LastEvaluatedKey;
          } while (startKey !== undefined);
          const orders = yield* Effect.forEach(items, toOrder);
          return { orders, readAt };
        }),
      };
    })
  );

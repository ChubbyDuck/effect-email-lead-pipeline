import { type DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Clock, Config, Effect, Layer, Schema } from 'effect';

import { type Request, RequestCounters, RequestEntry, type RequestProgress } from '#Core/Shared/Domain/request';
import {
  RequestLedger,
  RequestNotAcknowledged,
  RequestNotRecorded,
  RequestNotRead,
  RequestsNotListed,
} from '#Core/Shared/Ports/RequestLedger';
import { nameOf } from '#Infrastructure/Shared/awsErrors';

/** In seconds. DynamoDB deletes an entry about this long after its last change, so the table and its scans stay small. */
export const retentionSeconds = 7 * 24 * 60 * 60;

/**
 * The time of a write, as an ISO string because DynamoDB has no date type, and the time when the TTL of the table
 * deletes the entry, in epoch seconds as TTL needs. Each write moves the deletion, so an active request stays.
 */
const writeTime = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => ({
    at: new Date(millis).toISOString(),
    expiresAt: Math.floor(millis / 1000) + retentionSeconds,
  }))
);

type WriteTime = Effect.Success<typeof writeTime>;

const toItem = (request: Request, { at, expiresAt }: WriteTime): Record<string, unknown> => ({
  requestID: request.requestID,
  receivedAt: request.receivedAt.toISOString(),
  updatedAt: at,
  expiresAt,
  inboxStatus: request.inboxStatus,
});

/**
 * One update for one change. `SET` writes the values, and `ADD` adds each counter delta. `ADD` on a top-level number
 * is atomic and starts from 0, so the order of the changes does not matter. A delta of 0 changes nothing, so it gets
 * no `ADD`.
 */
const toUpdate = (progress: RequestProgress, { at, expiresAt }: WriteTime) => {
  const values: Record<string, unknown> = { updatedAt: at, expiresAt };
  if (progress.inboxStatus !== undefined) values.inboxStatus = progress.inboxStatus;
  if (progress.attachments !== undefined) values.attachments = progress.attachments;
  const deltas = RequestCounters.flatMap((counter) => {
    const delta = progress[counter];
    return delta === undefined || delta === 0 ? [] : [[counter, delta] as const];
  });

  const set = Object.keys(values).map((name) => `#${name} = :${name}`);
  const add = deltas.map(([name]) => `#${name} :${name}`);
  const attributes = [...Object.entries(values), ...deltas];
  return {
    UpdateExpression: [`SET ${set.join(', ')}`, ...(add.length > 0 ? [`ADD ${add.join(', ')}`] : [])].join(' '),
    ExpressionAttributeNames: Object.fromEntries(attributes.map(([name]) => [`#${name}`, name])),
    ExpressionAttributeValues: Object.fromEntries(attributes.map(([name, value]) => [`:${name}`, value])),
  };
};

const decodeEntries = Schema.decodeUnknownEffect(Schema.Array(RequestEntry));
const decodeEntry = Schema.decodeUnknownEffect(RequestEntry);

/**
 * Keeps each entry as one item, keyed by its request ID. The put is conditional, so an entry that is already in the
 * ledger stays as it is, and a redrive or a second delivery of the email succeeds without a change of its status.
 */
export const makeRequestLedgerLive = (dynamo: DynamoDBDocumentClient) =>
  Layer.effect(
    RequestLedger,
    Effect.gen(function* () {
      const tableName = yield* Config.String('REQUEST_LEDGER_TABLE_NAME');

      return {
        acknowledge: (request) =>
          writeTime.pipe(
            Effect.andThen((time) =>
              Effect.tryPromise({
                try: (abortSignal) =>
                  dynamo.send(
                    new PutCommand({
                      TableName: tableName,
                      Item: toItem(request, time),
                      ConditionExpression: 'attribute_not_exists(requestID)',
                    }),
                    { abortSignal }
                  ),
                catch: (reason) => new RequestNotAcknowledged({ request, reason }),
              })
            ),
            Effect.asVoid,
            Effect.catchIf(
              ({ reason }) => nameOf(reason) === 'ConditionalCheckFailedException',
              () => Effect.void
            )
          ),
        record: (requestID, progress) =>
          writeTime.pipe(
            Effect.andThen((time) =>
              Effect.tryPromise({
                try: (abortSignal) =>
                  dynamo.send(
                    new UpdateCommand({ TableName: tableName, Key: { requestID }, ...toUpdate(progress, time) }),
                    { abortSignal }
                  ),
                catch: (reason) => new RequestNotRecorded({ requestID, progress, reason }),
              })
            ),
            Effect.asVoid
          ),
        /**
         * Scans the table, because no index has `updatedAt` as its key. The filter compares ISO strings, which sort as
         * their dates do. A scan reads every item, so its cost grows with the table, not with the result.
         */
        changedSince: (since) =>
          Effect.gen(function* () {
            const items: unknown[] = [];
            let startKey: Record<string, unknown> | undefined;
            do {
              const page = yield* Effect.tryPromise({
                try: (abortSignal) =>
                  dynamo.send(
                    new ScanCommand({
                      TableName: tableName,
                      FilterExpression: '#updatedAt >= :since',
                      ExpressionAttributeNames: { '#updatedAt': 'updatedAt' },
                      ExpressionAttributeValues: { ':since': since.toISOString() },
                      ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
                    }),
                    { abortSignal }
                  ),
                catch: (reason) => new RequestsNotListed({ since, reason }),
              });
              items.push(...(page.Items ?? []));
              startKey = page.LastEvaluatedKey;
            } while (startKey !== undefined);
            return yield* decodeEntries(items).pipe(
              Effect.mapError((reason) => new RequestsNotListed({ since, reason }))
            );
          }),
        entryOf: (requestID) =>
          Effect.gen(function* () {
            const { Item } = yield* Effect.tryPromise({
              try: (abortSignal) =>
                dynamo.send(new GetCommand({ TableName: tableName, Key: { requestID } }), { abortSignal }),
              catch: (reason) => new RequestNotRead({ requestID, reason }),
            });
            if (Item === undefined) return undefined;
            return yield* decodeEntry(Item).pipe(
              Effect.mapError((reason) => new RequestNotRead({ requestID, reason }))
            );
          }),
      };
    })
  );

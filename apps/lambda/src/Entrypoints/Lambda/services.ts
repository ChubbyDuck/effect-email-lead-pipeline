import { AppConfigDataClient } from '@aws-sdk/client-appconfigdata';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { makeEmailParserLive } from '@leads/pipeline/infrastructure/EmailParser/live';
import { ExcelSheetParserLive } from '@leads/pipeline/infrastructure/ExcelSheetParser/live';
import { GuardLive } from '@leads/pipeline/infrastructure/Guard/live';
import { withOrderWriteLimit } from '@leads/pipeline/infrastructure/OrderRepository/limited';
import { makeOrderRepositoryLive } from '@leads/pipeline/infrastructure/OrderRepository/live';
import { makeRuntimeSettingsLive } from '@leads/pipeline/infrastructure/RuntimeSettings/live';
import { makeStorageLive } from '@leads/pipeline/infrastructure/Storage/live';
import { makeRequestLedgerLive } from '@leads/shared/infrastructure/RequestLedger/live';
import { Effect, Layer } from 'effect';
import { RateLimiter } from 'effect/persistence';
import { simpleParser } from 'mailparser';

import { flociEndpoint } from './flociEndpoint';

const s3 = new S3Client(flociEndpoint === undefined ? {} : { endpoint: flociEndpoint, forcePathStyle: true });
const storage = makeStorageLive(s3);
const dynamo = DynamoDBDocumentClient.from(
  new DynamoDBClient(flociEndpoint === undefined ? {} : { endpoint: flociEndpoint })
);
// One bucket of order writes per execution environment, so the order write limit holds from one invocation to the next.
const orderWriteLimiter = Effect.runSync(RateLimiter.make.pipe(Effect.provide(RateLimiter.layerStoreMemory)));
const orderRepository = makeOrderRepositoryLive(dynamo).pipe(withOrderWriteLimit(orderWriteLimiter));
const requestLedger = makeRequestLedgerLive(dynamo);
// One cache per execution environment, so warm invocations poll AppConfig at most once per refresh.
const runtimeSettings = makeRuntimeSettingsLive(
  new AppConfigDataClient(flociEndpoint === undefined ? {} : { endpoint: flociEndpoint })
);

export const LambdaServicesLive = Layer.mergeAll(
  storage,
  makeEmailParserLive(simpleParser),
  ExcelSheetParserLive,
  GuardLive,
  orderRepository,
  requestLedger
).pipe(Layer.provideMerge(runtimeSettings));

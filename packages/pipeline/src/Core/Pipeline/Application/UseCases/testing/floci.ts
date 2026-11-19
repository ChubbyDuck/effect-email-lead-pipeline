import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ScalarAttributeType } from '@aws-sdk/client-dynamodb';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { makeRequestLedger, requestLedgerBuilder } from '@leads/shared/infrastructure/RequestLedger/mock/variants';
import { type Config, ConfigProvider, Layer, Logger } from 'effect';
import { TestClock } from 'effect/testing';
import { simpleParser } from 'mailparser';

import type { OrderRepository } from '#Core/Pipeline/Ports/OrderRepository';
import { makeEmailParserLive } from '#Infrastructure/Pipeline/EmailParser/live';
import { ExcelSheetParserLive } from '#Infrastructure/Pipeline/ExcelSheetParser/live';
import { GuardLive } from '#Infrastructure/Pipeline/Guard/live';
import { makeOrderRepositoryLive } from '#Infrastructure/Pipeline/OrderRepository/live';
import { makeQueueLive } from '#Infrastructure/Pipeline/Queue/live';
import { makeStorageLive } from '#Infrastructure/Pipeline/Storage/live';

export const instant = new Date(2026, 8, 27, 14, 37);
/** The folder that the inbox makes from `instant` for the sources of a request. */
export const storedAt = '27-09-2026/14-30';

export function leadRecords(messages: readonly Message[]) {
  return messages.map((message) => {
    if (!message.MessageId || message.Body === undefined) throw new Error('Incomplete SQS message');
    return { messageId: message.MessageId, body: message.Body };
  });
}

export function makeFloci() {
  const suffix = randomUUID();
  const s3 = new S3Client({
    endpoint: process.env.FLOCI_ENDPOINT ?? 'http://127.0.0.1:4566',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    forcePathStyle: true,
  });
  const sqs = new SQSClient({
    endpoint: process.env.FLOCI_ENDPOINT ?? 'http://127.0.0.1:4566',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    useQueueUrlAsEndpoint: false,
  });
  const dynamo = new DynamoDBClient({
    endpoint: process.env.FLOCI_ENDPOINT ?? 'http://127.0.0.1:4566',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const documents = DynamoDBDocumentClient.from(dynamo);
  const ordersTable = `leads-orders-${suffix}`;
  let queueUrl: string;
  const buckets = {
    inbox: `leads-inbox-${suffix}`,
    sources: `leads-source-${suffix}`,
  };

  async function keys(bucket: string): Promise<string[]> {
    const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket }));
    return (response.Contents ?? []).flatMap((item) => (item.Key === undefined ? [] : [item.Key]));
  }

  return {
    buckets,
    ordersTable,
    get queueUrl() {
      return queueUrl;
    },
    async setup() {
      for (const bucket of Object.values(buckets)) await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      const response = await sqs.send(new CreateQueueCommand({ QueueName: `leads-${suffix}` }));
      if (!response.QueueUrl) throw new Error('Floci did not return a queue URL');
      queueUrl = response.QueueUrl;
      await dynamo.send(
        new CreateTableCommand({
          TableName: ordersTable,
          KeySchema: [{ AttributeName: 'idempotencyKey', KeyType: 'HASH' }],
          AttributeDefinitions: [{ AttributeName: 'idempotencyKey', AttributeType: ScalarAttributeType.S }],
          BillingMode: 'PAY_PER_REQUEST',
        })
      );
    },
    async cleanup() {
      try {
        if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
        await dynamo.send(new DeleteTableCommand({ TableName: ordersTable })).catch(() => undefined);
        for (const bucket of Object.values(buckets)) {
          for (const key of await keys(bucket)) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
        }
      } finally {
        s3.destroy();
        sqs.destroy();
        dynamo.destroy();
      }
    },
    keys,
    /** The stored order of the idempotency key, or `undefined` when there is none. */
    async order(idempotencyKey: string): Promise<Record<string, unknown> | undefined> {
      const { Item } = await documents.send(
        new GetCommand({ TableName: ordersTable, Key: { idempotencyKey }, ConsistentRead: true })
      );
      return Item;
    },
    async receiveLeads(): Promise<Message[]> {
      const received: Message[] = [];
      while (true) {
        const response = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 1,
          })
        );
        if (!response.Messages?.length) return received;
        for (const message of response.Messages) {
          if (!message.MessageId || !message.ReceiptHandle || message.Body === undefined) {
            throw new Error('Incomplete SQS message');
          }
          received.push(message);
        }
      }
    },
    async acknowledge(message: Message) {
      if (!message.ReceiptHandle) throw new Error('SQS message has no receipt handle');
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    },
    async sendLeadMessage(body: string) {
      await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    },
    /** Makes an unacknowledged record visible again without waiting for its visibility timeout. */
    async releaseLead(message: Message) {
      if (!message.ReceiptHandle) throw new Error('SQS message has no receipt handle');
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: 0,
        })
      );
    },
    async put(bucket: string, key: string, body: Buffer) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    },
    async get(bucket: string, key: string): Promise<Buffer> {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return Buffer.from(await response.Body!.transformToByteArray());
    },
    async exists(bucket: string, key: string): Promise<boolean> {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          '$metadata' in error &&
          (error.$metadata as { httpStatusCode?: number }).httpStatusCode === 404
        )
          return false;
        throw error;
      }
    },
    services(
      logged: { errors: unknown[]; warnings: unknown[] },
      orderRepository: Layer.Layer<OrderRepository, Config.ConfigError> = makeOrderRepositoryLive(documents),
      sourcesBucket = buckets.sources,
      leadsQueueUrl = queueUrl,
      ordersTableName = ordersTable
    ) {
      const storage = makeStorageLive(s3);
      const configProvider = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          LEAD_SOURCES_BUCKET_NAME: sourcesBucket,
          LEADS_QUEUE_URL: leadsQueueUrl,
          LEADS_PROCESSING_MAX_CONCURRENCY: 2,
          ORDERS_TABLE_NAME: ordersTableName,
          LEAD_PROCESSING_RETRY: 2,
          LEAD_PROCESSING_TIMEOUT: 45_000,
          INBOX_INTERNAL_CONCURRENCY: 2,
          LEAD_SOURCES_INTERNAL_CONCURRENCY: 2,
          LEAD_INTERNAL_CONCURRENCY: 2,
          INBOX_SENDER_WHITELIST: ['owner@example.com'],
        })
      );
      return Layer.mergeAll(
        TestClock.layer(),
        storage,
        makeEmailParserLive(simpleParser),
        ExcelSheetParserLive,
        GuardLive,
        orderRepository,
        // Floci has no request ledger table yet, so the handlers acknowledge their requests and record progress in a mock.
        makeRequestLedger(requestLedgerBuilder.acknowledge('succeeds').record('succeeds')).layer,
        makeQueueLive(sqs),
        Logger.layer([
          Logger.make((options) => {
            const messages = Array.isArray(options.message) ? options.message : [options.message];
            if (options.logLevel === 'Error') logged.errors.push(...messages);
            if (options.logLevel === 'Warn') logged.warnings.push(...messages);
          }),
        ])
      ).pipe(Layer.provideMerge(configProvider));
    },
  };
}

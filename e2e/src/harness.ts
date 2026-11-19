import { randomUUID } from 'node:crypto';

import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageBatchCommand,
  SendMessageCommand,
  SetQueueAttributesCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import type { Control, Observation, Stage } from '@leads/lambda/e2e/control';
import { email, type Attachment, type EmailOptions } from '@leads/pipeline/testing/email';
import { deploymentNamed } from '@leads/shared/deployments';
import { queueSettings } from '@leads/shared/domain/queueSettings';
import { resourceNames } from '@leads/shared/names';
import type { SQSEvent } from 'aws-lambda';

const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const endpoint = process.env.FLOCI_ENDPOINT ?? 'http://127.0.0.1:4567';
const config = { endpoint, region: 'us-east-1', credentials };
/** The e2e deployment under test (`e2e-cdk` or `e2e-alchemy`), which test-e2e-floci.sh selects. */
const prefix = process.env.LEADS_BUCKET_PREFIX ?? deploymentNamed(process.env.DEPLOYMENT ?? 'e2e-cdk').prefix;
const names = resourceNames(prefix);
/** The stage of the naming contract for each stage of the control file. */
const stageNameOf = { inbox: 'inbox', 'lead-sources': 'leadSources', leads: 'leads' } as const;
const stages: readonly Stage[] = ['inbox', 'lead-sources', 'leads'];

export async function waitFor<A>(
  description: string,
  check: () => Promise<A | undefined>,
  timeout = 60_000
): Promise<A> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export function makeDeployedPipeline() {
  const s3 = new S3Client({ ...config, forcePathStyle: true });
  const sqs = new SQSClient({ ...config, useQueueUrlAsEndpoint: false });
  const lambda = new LambdaClient(config);
  const queues = new Map<Stage, { url: string; dlq: string; arn: string; mapping: string }>();
  let control: Control = { id: 'unset', faults: [] };
  let baseline: Record<Stage, number> = { inbox: 0, 'lead-sources': 0, leads: 0 };
  const bucket = (suffix: 'inbox' | 'lead-sources' | 'e2e') =>
    suffix === 'e2e' ? names.e2eBucket : names.bucket(stageNameOf[suffix]);

  async function depth(url: string) {
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      })
    );
    return (
      Number(Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  }

  async function keys(suffix: Parameters<typeof bucket>[0], keyPrefix?: string) {
    const { Contents } = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket(suffix),
        ...(keyPrefix !== undefined && { Prefix: keyPrefix }),
      })
    );
    return (Contents ?? []).flatMap((item) => (item.Key === undefined ? [] : [item.Key]));
  }

  async function observations() {
    const result = await Promise.all(
      (await keys('e2e', `_e2e/${control.id}/`)).map(async (key) => {
        const response = await s3.send(new GetObjectCommand({ Bucket: bucket('e2e'), Key: key }));
        return JSON.parse(await response.Body!.transformToString()) as Observation;
      })
    );
    return result.sort((a, b) => a.at - b.at);
  }

  async function assertNoDlqConsumers() {
    for (const stage of stages) {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({
          QueueUrl: queues.get(stage)!.dlq,
          AttributeNames: ['QueueArn', 'MessageRetentionPeriod'],
        })
      );
      if (Attributes?.MessageRetentionPeriod !== String(queueSettings.deadLetterRetention / 1000))
        throw new Error(`${stage}: wrong DLQ retention`);
      const { EventSourceMappings } = await lambda.send(
        new ListEventSourceMappingsCommand({ EventSourceArn: Attributes.QueueArn })
      );
      if (EventSourceMappings?.some((mapping) => mapping.EventSourceArn === Attributes.QueueArn))
        throw new Error(`${stage}: DLQ has a consumer`);
    }
  }

  return {
    bucket,
    keys,
    observations,
    async setup() {
      for (const stage of stages) {
        const { QueueUrl: url } = await sqs.send(
          new GetQueueUrlCommand({ QueueName: names.queue(stageNameOf[stage]) })
        );
        const { QueueUrl: dlq } = await sqs.send(new GetQueueUrlCommand({ QueueName: names.dlq(stageNameOf[stage]) }));
        if (!url || !dlq) throw new Error(`Missing ${stage} queues`);
        const { Attributes } = await sqs.send(
          new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn', 'RedrivePolicy'] })
        );
        const arn = Attributes?.QueueArn;
        if (!arn) throw new Error(`Missing ${stage} queue ARN`);
        const redrive = JSON.parse(Attributes.RedrivePolicy ?? '{}') as { maxReceiveCount: number };
        if (Number(redrive.maxReceiveCount) !== queueSettings.maxReceiveCount)
          throw new Error(`${stage}: wrong redrive budget`);
        const { EventSourceMappings } = await lambda.send(new ListEventSourceMappingsCommand({ EventSourceArn: arn }));
        const mappings = EventSourceMappings?.filter((mapping) => mapping.EventSourceArn === arn);
        const mapping = mappings?.[0];
        if (mappings?.length !== 1 || !mapping?.UUID || !mapping.FunctionArn || mapping.State !== 'Enabled')
          throw new Error(`${stage}: invalid mapping`);
        if (stage === 'leads' && !mapping.FunctionResponseTypes?.includes('ReportBatchItemFailures'))
          throw new Error('Partial responses disabled');
        queues.set(stage, { url, dlq, arn, mapping: mapping.UUID });
        // Runtime-only local speed settings. The deploy of the CDK e2e stack checks its deployed production settings.
        // For the Alchemy stack, only the plan test of @leads/alchemy checks them, before the deploy.
        await sqs.send(new SetQueueAttributesCommand({ QueueUrl: url, Attributes: { VisibilityTimeout: '1' } }));
        if (stage === 'leads')
          await lambda.send(
            new UpdateEventSourceMappingCommand({ UUID: mapping.UUID, MaximumBatchingWindowInSeconds: 1 })
          );
        // The one mapping of the queue points at the function of the stage, whatever IaC tool made the deployment.
        const functionArn = mapping.FunctionArn;
        const fn = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionArn }));
        await lambda.send(
          new UpdateFunctionConfigurationCommand({
            FunctionName: functionArn,
            Environment: {
              Variables: {
                ...fn.Environment?.Variables,
                LEAD_PROCESSING_RETRY: '2',
                LEAD_PROCESSING_RETRY_DELAY: '100',
                // The waits of two retries take at most 360ms of this timeout.
                LEAD_PROCESSING_TIMEOUT: '1100',
                LEAD_INTERNAL_CONCURRENCY: '2',
                LEAD_SOURCES_INTERNAL_CONCURRENCY: '2',
                INBOX_INTERNAL_CONCURRENCY: '2',
              },
            },
          })
        );
      }
      await assertNoDlqConsumers();
    },
    async begin(faults: Control['faults'] = [], shutdownStage?: Stage, invalidConfigStage?: Stage) {
      await waitFor('previous main queues to drain', async () =>
        (await Promise.all(stages.map((stage) => depth(queues.get(stage)!.url)))).every((n) => n === 0)
          ? true
          : undefined
      );
      baseline = Object.fromEntries(
        await Promise.all(stages.map(async (stage) => [stage, await depth(queues.get(stage)!.dlq)]))
      ) as Record<Stage, number>;
      control = {
        id: randomUUID(),
        faults,
        ...(shutdownStage !== undefined && { shutdownStage }),
        ...(invalidConfigStage !== undefined && { invalidConfigStage }),
      };
      await s3.send(
        new PutObjectCommand({ Bucket: bucket('e2e'), Key: '_e2e/control.json', Body: JSON.stringify(control) })
      );
      return control.id;
    },
    async put(suffix: Parameters<typeof bucket>[0], key: string, body: Buffer | string) {
      await s3.send(new PutObjectCommand({ Bucket: bucket(suffix), Key: key, Body: body }));
    },
    async submit(attachments: readonly Attachment[], sender = 'Test <owner@example.com>', options: EmailOptions = {}) {
      const key = `received/${control.id}.eml`;
      await s3.send(
        new PutObjectCommand({ Bucket: bucket('inbox'), Key: key, Body: email(sender, attachments, options) })
      );
      return key;
    },
    async exists(suffix: Parameters<typeof bucket>[0], key: string) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket: bucket(suffix), Key: key }));
        return true;
      } catch (error) {
        if (error instanceof Error && ['NotFound', 'NoSuchKey'].includes(error.name)) return false;
        throw error;
      }
    },
    async poison(stage: Stage, body: string) {
      const result = await sqs.send(new SendMessageCommand({ QueueUrl: queues.get(stage)!.url, MessageBody: body }));
      if (!result.MessageId) throw new Error('Missing sent message ID');
      return result.MessageId;
    },
    async sendBatch(leads: readonly unknown[]) {
      const queue = queues.get('leads')!;
      await lambda.send(new UpdateEventSourceMappingCommand({ UUID: queue.mapping, Enabled: false }));
      const entries = leads.map((lead, index) => ({
        Id: String(index),
        MessageBody: JSON.stringify({ lead, requestID: control.id }),
      }));
      try {
        const result = await sqs.send(new SendMessageBatchCommand({ QueueUrl: queue.url, Entries: entries }));
        if (result.Failed?.length || result.Successful?.length !== leads.length)
          throw new Error('Failed to enqueue test batch');
        return new Map(result.Successful.map((item) => [Number(item.Id), item.MessageId!]));
      } finally {
        await lambda.send(new UpdateEventSourceMappingCommand({ UUID: queue.mapping, Enabled: true }));
      }
    },
    async settle(stage: Stage, expectedDlqs: Partial<Record<Stage, number>> = {}) {
      return waitFor(`${stage} outcome, main-queue acknowledgement, and exact DLQ counts`, async () => {
        for (const candidate of stages) {
          if ((await depth(queues.get(candidate)!.url)) !== 0) return;
          if ((await depth(queues.get(candidate)!.dlq)) !== baseline[candidate] + (expectedDlqs[candidate] ?? 0))
            return;
        }
        // Read the observations after the queues: a handler writes them before SQS deletes its messages, so empty
        // queues mean the snapshot is complete. Read before, a batch that ends between the reads goes missing.
        const events = await observations();
        return events.some((item) => item.stage === stage && (item.kind === 'response' || item.kind === 'error'))
          ? events
          : undefined;
      });
    },
    async dlqMessages(stage: Stage) {
      // Inspection only: never acknowledge, purge, redrive, or attach a consumer to a DLQ.
      const seen = new Map<string, Message>();
      for (;;) {
        const { Messages } = await sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queues.get(stage)!.dlq,
            MaxNumberOfMessages: 10,
            VisibilityTimeout: 1,
            WaitTimeSeconds: 0,
          })
        );
        if (!Messages?.length) return [...seen.values()];
        for (const message of Messages) seen.set(message.MessageId!, message);
      }
    },
    assertNoDlqConsumers,
    dispose() {
      s3.destroy();
      sqs.destroy();
      lambda.destroy();
    },
  };
}

export const recordsIn = (events: readonly Observation[], stage: Stage) =>
  events
    .filter((item) => item.stage === stage && item.kind === 'start')
    .flatMap((item) => (item.value as SQSEvent).Records);
export const attemptsOf = (events: readonly Observation[], stage: Stage, method: string) =>
  events.filter((item) => item.stage === stage && item.method === method && item.kind === 'attempt');
export const successesOf = (events: readonly Observation[], stage: Stage, method: string) =>
  events.filter(
    (item) =>
      item.stage === stage &&
      item.method === method &&
      item.kind === 'outcome' &&
      (item.value as { tag: string }).tag === 'Success'
  );

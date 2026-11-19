import {
  AppConfigClient,
  GetHostedConfigurationVersionCommand,
  ListApplicationsCommand,
  ListConfigurationProfilesCommand,
  ListDeploymentsCommand,
  ListEnvironmentsCommand,
} from '@aws-sdk/client-appconfig';
import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { DescribeTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  GetFunctionConcurrencyCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
} from '@aws-sdk/client-lambda';
import { ListObjectsV2Command, S3Client, type _Object } from '@aws-sdk/client-s3';
import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient, type QueueAttributeName } from '@aws-sdk/client-sqs';
import type { Deployment } from '@leads/shared/deployments';
import { stageNames, type StageName } from '@leads/shared/domain/stages';
import { resourceNames } from '@leads/shared/names';

import { parseLine } from '#Core/Observation/Domain/runs';
import {
  type BucketStatus,
  type HandlerStatus,
  type Json,
  type LogEvent,
  type QueueStatus,
  section,
  type Series,
  type SettingsStatus,
  type StoredObject,
  type TableStatus,
  total,
  type Usage,
} from '#Core/Observation/Domain/snapshot';
import { toSeries, windowOf, type Window } from '#Core/Observation/Domain/time';
import { emailBytesOf } from '#Core/Observation/Domain/trail';
import type { DeploymentStatusSource } from '#Core/Observation/Ports/DeploymentStatusSource';
import type { StatusSource } from '#Core/Observation/Ports/StatusSource';

/** The stages that have a bucket. The leads stage gets its leads from its queue. */
const bucketStages = ['inbox', 'leadSources'] as const satisfies readonly StageName[];

/** The most objects that the source lists in one bucket. */
const objectLimit = 1000;
/** The most log events that the source reads from one log group. */
const logEventLimit = 500;
/** The most log events in one snapshot. */
const logLimit = 100;
const logPattern = '?ERROR ?WARN ?"Task timed out"';
/** The lines that give the size of a file that a handler read. */
const fileSizePattern = '"File size of request"';

const iso = (date: Date | undefined) => (date ?? new Date(0)).toISOString();

interface MetricSpec {
  readonly namespace: string;
  readonly metric: string;
  readonly dimension: readonly [name: string, value: string];
  readonly stat: 'Sum' | 'Maximum';
}

interface MetricResult {
  readonly series: Series;
  /** The value of the newest period with a datapoint. */
  readonly last?: number;
}

export const queueNameOf = (prefix: string, stage: StageName, role: QueueStatus['role']) =>
  role === 'dlq' ? resourceNames(prefix).dlq(stage) : resourceNames(prefix).queue(stage);

/** Finds each handler through the trigger on the queue of its stage, because the stack names functions with a hash. */
export async function readFunctions(lambda: LambdaClient, { region, account, prefix }: Deployment) {
  return Promise.all(
    stageNames.map(async (stage) => {
      const queueArn = `arn:aws:sqs:${region}:${account}:${queueNameOf(prefix, stage, 'main')}`;
      const { EventSourceMappings } = await lambda.send(
        new ListEventSourceMappingsCommand({ EventSourceArn: queueArn })
      );
      const mapping = EventSourceMappings?.[0];
      if (mapping?.FunctionArn === undefined) throw new Error(`No Lambda trigger on ${queueArn}`);
      const [configuration, concurrency] = await Promise.all([
        lambda.send(new GetFunctionConfigurationCommand({ FunctionName: mapping.FunctionArn })),
        lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: mapping.FunctionArn })).catch(() => undefined),
      ]);
      const functionName = configuration.FunctionName ?? mapping.FunctionArn;
      return { stage, mapping, configuration, concurrency, functionName };
    })
  );
}

export type HandlerFunction = Awaited<ReturnType<typeof readFunctions>>[number];

export const logGroupOf = ({ configuration, functionName }: HandlerFunction) =>
  configuration.LoggingConfig?.LogGroup ?? `/aws/lambda/${functionName}`;

async function listObjects(s3: S3Client, bucket: string, limit: number) {
  const objects: _Object[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        MaxKeys: Math.min(1000, limit - objects.length),
        ...(token === undefined ? {} : { ContinuationToken: token }),
      })
    );
    objects.push(...(page.Contents ?? []));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (objects.length >= limit) return { objects, truncated: token !== undefined };
  } while (token !== undefined);
  return { objects, truncated: false };
}

/** Lists the objects of each stage bucket, newest first. */
export function readBuckets(s3: S3Client, prefix: string): Promise<BucketStatus[]> {
  const toStored = (object: _Object): StoredObject => ({
    key: object.Key ?? '',
    lastModified: iso(object.LastModified),
    size: object.Size ?? 0,
  });
  return Promise.all(
    bucketStages.map(async (stage): Promise<BucketStatus> => {
      const bucket = resourceNames(prefix).bucket(stage);
      const listed = await listObjects(s3, bucket, objectLimit);
      const objects = listed.objects.map(toStored).toSorted((a, b) => b.lastModified.localeCompare(a.lastModified));
      return { name: bucket, stage, objects, truncated: listed.truncated };
    })
  );
}

/** The messages of a queue in its attributes, as SQS counts them. */
export function queueCounts(attributes: Partial<Record<string, string>>) {
  const count = (key: QueueAttributeName) => Number(attributes[key] ?? 0);
  return {
    visible: count('ApproximateNumberOfMessages'),
    inFlight: count('ApproximateNumberOfMessagesNotVisible'),
    delayed: count('ApproximateNumberOfMessagesDelayed'),
  };
}

export interface AwsStatusSourceOptions {
  readonly name: string;
  readonly deployment: Deployment;
  /** The endpoint of an emulator, such as Floci. */
  readonly endpoint?: string;
}

/** The snapshot of the deployment. `deploymentStatusSource` is the adapter of the IaC tool that made it. */
export function makeAwsStatusSource(
  { name, deployment, endpoint }: AwsStatusSourceOptions,
  deploymentStatusSource: DeploymentStatusSource
): StatusSource {
  const { region, prefix } = deployment;
  const names = resourceNames(prefix);
  const config = { region, ...(endpoint === undefined ? {} : { endpoint }) };
  const appConfig = new AppConfigClient(config);
  const cloudWatch = new CloudWatchClient(config);
  const logs = new CloudWatchLogsClient(config);
  const dynamo = new DynamoDBClient(config);
  const lambda = new LambdaClient(config);
  const s3 = new S3Client({ ...config, forcePathStyle: endpoint !== undefined });
  const sqs = new SQSClient(config);

  const queueName = (stage: StageName, role: QueueStatus['role']) => queueNameOf(prefix, stage, role);

  /** Each metric that GetMetricData requests costs money, so the source counts them. */
  let metricsRequested = 0;

  async function metrics(window: Window, specs: readonly MetricSpec[]): Promise<MetricResult[]> {
    metricsRequested += specs.length;
    const queries: MetricDataQuery[] = specs.map((spec, index) => ({
      Id: `m${index}`,
      MetricStat: {
        Metric: {
          Namespace: spec.namespace,
          MetricName: spec.metric,
          Dimensions: [{ Name: spec.dimension[0], Value: spec.dimension[1] }],
        },
        Period: window.periodSeconds,
        Stat: spec.stat,
      },
    }));
    const points = specs.map(() => ({ timestamps: [] as Date[], values: [] as number[] }));
    let nextToken: string | undefined;
    do {
      const page = await cloudWatch.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries,
          StartTime: window.start,
          EndTime: window.end,
          ScanBy: 'TimestampAscending',
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        })
      );
      for (const result of page.MetricDataResults ?? []) {
        const target = points[Number(result.Id?.slice(1))];
        target?.timestamps.push(...(result.Timestamps ?? []));
        target?.values.push(...(result.Values ?? []));
      }
      nextToken = page.NextToken;
    } while (nextToken !== undefined);
    return points.map(({ timestamps, values }) => {
      const last = values.at(-1);
      return { series: toSeries(window, timestamps, values), ...(last !== undefined && { last }) };
    });
  }

  async function readHandlers(window: Window, functions: readonly HandlerFunction[]) {
    const names = ['Invocations', 'Errors', 'Throttles', 'Duration', 'ConcurrentExecutions'] as const;
    const results = await metrics(
      window,
      functions.flatMap(({ functionName }) =>
        names.map(
          (metric): MetricSpec => ({
            namespace: 'AWS/Lambda',
            metric,
            dimension: ['FunctionName', functionName],
            stat: metric === 'Duration' || metric === 'ConcurrentExecutions' ? 'Maximum' : 'Sum',
          })
        )
      )
    );
    return functions.map(({ stage, mapping, configuration, concurrency, functionName }, index): HandlerStatus => {
      const [invocations, errors, throttles, durationMax, concurrencyMax] = names.map(
        (_, offset) => results[index * names.length + offset]!.series
      ) as [Series, Series, Series, Series, Series];
      const reserved = concurrency?.ReservedConcurrentExecutions;
      const maximumConcurrency = mapping.ScalingConfig?.MaximumConcurrency;
      return {
        stage,
        functionName,
        state: configuration.State ?? 'Unknown',
        lastUpdateStatus: configuration.LastUpdateStatus ?? 'Unknown',
        lastModified: configuration.LastModified ?? '',
        timeoutSeconds: configuration.Timeout ?? 0,
        memoryMb: configuration.MemorySize ?? 0,
        ...(reserved !== undefined && { reservedConcurrency: reserved }),
        mapping: {
          state: mapping.State ?? 'Unknown',
          batchSize: mapping.BatchSize ?? 0,
          ...(maximumConcurrency !== undefined && { maximumConcurrency }),
        },
        invocations,
        errors,
        throttles,
        durationMax,
        concurrencyMax,
      };
    });
  }

  async function readQueues(window: Window): Promise<QueueStatus[]> {
    const queues = stageNames.flatMap((stage) => (['main', 'dlq'] as const).map((role) => ({ stage, role })));
    const [attributes, results] = await Promise.all([
      Promise.all(
        queues.map(async ({ stage, role }) => {
          const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName(stage, role) }));
          const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['All'] }));
          return { url: QueueUrl ?? '', attributes: Attributes ?? {} };
        })
      ),
      metrics(
        window,
        queues.flatMap(({ stage, role }): MetricSpec[] => [
          {
            namespace: 'AWS/SQS',
            metric: 'ApproximateAgeOfOldestMessage',
            dimension: ['QueueName', queueName(stage, role)],
            stat: 'Maximum',
          },
          {
            namespace: 'AWS/SQS',
            metric: 'NumberOfMessagesSent',
            dimension: ['QueueName', queueName(stage, role)],
            stat: 'Sum',
          },
        ])
      ),
    ]);
    return queues.map(({ stage, role }, index): QueueStatus => {
      const { url, attributes: values } = attributes[index]!;
      const count = (key: QueueAttributeName) => Number(values[key] ?? 0);
      const age = results[index * 2]!.last;
      return {
        name: queueName(stage, role),
        url,
        stage,
        role,
        ...queueCounts(values),
        visibilityTimeoutSeconds: count('VisibilityTimeout'),
        ...queueLimits(values),
        ...(age !== undefined && { oldestAgeSeconds: age }),
        sent: results[index * 2 + 1]!.series,
      };
    });
  }

  async function readOrders(window: Window): Promise<TableStatus> {
    const name = names.ordersTable;
    const [{ Table }, [writes, throttles]] = await Promise.all([
      dynamo.send(new DescribeTableCommand({ TableName: name })),
      metrics(window, [
        {
          namespace: 'AWS/DynamoDB',
          metric: 'ConsumedWriteCapacityUnits',
          dimension: ['TableName', name],
          stat: 'Sum',
        },
        { namespace: 'AWS/DynamoDB', metric: 'WriteThrottleEvents', dimension: ['TableName', name], stat: 'Sum' },
      ]),
    ]);
    return {
      name,
      status: Table?.TableStatus ?? 'UNKNOWN',
      itemCount: Table?.ItemCount ?? 0,
      sizeBytes: Table?.TableSizeBytes ?? 0,
      writes: writes!.series,
      throttles: throttles!.series,
    };
  }

  async function readSettings(): Promise<SettingsStatus> {
    const { Items: applications } = await appConfig.send(new ListApplicationsCommand({ MaxResults: 50 }));
    const application = applications?.find((item) => item.Name === names.appConfigApplication);
    if (application?.Id === undefined) throw new Error(`No AppConfig application ${names.appConfigApplication}`);
    const ApplicationId = application.Id;
    const [{ Items: environments }, { Items: profiles }] = await Promise.all([
      appConfig.send(new ListEnvironmentsCommand({ ApplicationId, MaxResults: 50 })),
      appConfig.send(new ListConfigurationProfilesCommand({ ApplicationId, MaxResults: 50 })),
    ]);
    const live = environments?.find((item) => item.Name === 'live');
    const profile = profiles?.find((item) => item.Name === 'runtime-settings');
    if (live?.Id === undefined) throw new Error('No AppConfig environment live');

    const { Items: deployments } = await appConfig.send(
      new ListDeploymentsCommand({ ApplicationId, EnvironmentId: live.Id, MaxResults: 50 })
    );
    const latest = deployments
      ?.filter((item) => item.ConfigurationName === undefined || item.ConfigurationName === profile?.Name)
      .toSorted((a, b) => (b.DeploymentNumber ?? 0) - (a.DeploymentNumber ?? 0))[0];
    const version = Number(latest?.ConfigurationVersion);
    const content =
      profile?.Id === undefined || !Number.isInteger(version)
        ? undefined
        : await appConfig
            .send(
              new GetHostedConfigurationVersionCommand({
                ApplicationId,
                ConfigurationProfileId: profile.Id,
                VersionNumber: version,
              })
            )
            .then(({ Content }) => JSON.parse(new TextDecoder().decode(Content)) as Json);

    return {
      environmentState: live.State ?? 'UNKNOWN',
      ...(latest !== undefined && {
        deployment: {
          number: latest.DeploymentNumber ?? 0,
          state: latest.State ?? 'UNKNOWN',
          version: latest.ConfigurationVersion ?? '',
          startedAt: iso(latest.StartedAt),
          ...(latest.CompletedAt !== undefined && { completedAt: iso(latest.CompletedAt) }),
        },
      }),
      ...(content !== undefined && { content }),
    };
  }

  async function readLogs(window: Window, functions: readonly HandlerFunction[]) {
    const groups = await Promise.all(
      functions.map(async (handler) => {
        const { stage } = handler;
        const logGroupName = logGroupOf(handler);
        const events: LogEvent[] = [];
        let token: string | undefined;
        do {
          const page = await logs.send(
            new FilterLogEventsCommand({
              logGroupName,
              filterPattern: logPattern,
              startTime: window.start.getTime(),
              ...(token === undefined ? {} : { nextToken: token }),
            })
          );
          for (const event of page.events ?? []) events.push(toLogEvent(stage, event.timestamp, event.message));
          token = page.nextToken;
        } while (token !== undefined && events.length < logEventLimit);
        return events;
      })
    );
    return groups
      .flat()
      .toSorted((a, b) => b.time.localeCompare(a.time))
      .slice(0, logLimit);
  }

  /** The size lines of the inbox in the window. */
  async function readEmailBytes(window: Window, functions: readonly HandlerFunction[]) {
    const inbox = functions.find(({ stage }) => stage === 'inbox');
    if (inbox === undefined) return [];
    const lines: string[] = [];
    let token: string | undefined;
    do {
      const page = await logs.send(
        new FilterLogEventsCommand({
          logGroupName: logGroupOf(inbox),
          filterPattern: fileSizePattern,
          startTime: window.start.getTime(),
          ...(token === undefined ? {} : { nextToken: token }),
        })
      );
      for (const event of page.events ?? []) lines.push(event.message ?? '');
      token = page.nextToken;
    } while (token !== undefined);
    return emailBytesOf(lines);
  }

  async function readUsage(
    window: Window,
    functions: readonly HandlerFunction[]
  ): Promise<Omit<Usage, 'metricsPerRead'>> {
    const queues = stageNames.flatMap((stage) => (['main', 'dlq'] as const).map((role) => ({ stage, role })));
    const tables = [
      { name: names.ordersTable, role: 'orders' },
      { name: names.requestLedgerTable, role: 'ledger' },
    ] as const;
    const queueMetrics = [
      'NumberOfMessagesSent',
      'NumberOfMessagesReceived',
      'NumberOfMessagesDeleted',
      'NumberOfEmptyReceives',
    ] as const;
    const specs: MetricSpec[] = [
      ...functions.flatMap(({ functionName }): MetricSpec[] => [
        { namespace: 'AWS/Lambda', metric: 'Invocations', dimension: ['FunctionName', functionName], stat: 'Sum' },
        { namespace: 'AWS/Lambda', metric: 'Duration', dimension: ['FunctionName', functionName], stat: 'Sum' },
      ]),
      ...functions.map(
        (handler): MetricSpec => ({
          namespace: 'AWS/Logs',
          metric: 'IncomingBytes',
          dimension: ['LogGroupName', logGroupOf(handler)],
          stat: 'Sum',
        })
      ),
      ...queues.flatMap(({ stage, role }) =>
        queueMetrics.map(
          (metric): MetricSpec => ({
            namespace: 'AWS/SQS',
            metric,
            dimension: ['QueueName', queueName(stage, role)],
            stat: 'Sum',
          })
        )
      ),
      ...tables.flatMap(({ name: tableName }): MetricSpec[] => [
        {
          namespace: 'AWS/DynamoDB',
          metric: 'ConsumedReadCapacityUnits',
          dimension: ['TableName', tableName],
          stat: 'Sum',
        },
        {
          namespace: 'AWS/DynamoDB',
          metric: 'ConsumedWriteCapacityUnits',
          dimension: ['TableName', tableName],
          stat: 'Sum',
        },
      ]),
    ];
    const [results, sizes, stored, emailBytes] = await Promise.all([
      metrics(window, specs),
      Promise.all(
        tables.map(({ name: tableName }) =>
          dynamo
            .send(new DescribeTableCommand({ TableName: tableName }))
            .then(({ Table }) => Table?.TableSizeBytes ?? 0)
        )
      ),
      Promise.all(
        functions.map(async (handler) => {
          const logGroupName = logGroupOf(handler);
          const { logGroups } = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroupName }));
          return logGroups?.find((group) => group.logGroupName === logGroupName)?.storedBytes ?? 0;
        })
      ),
      readEmailBytes(window, functions),
    ]);
    let next = 0;
    /** The results come in the order of the specs. */
    const take = () => total(results[next++]!.series);
    const handlerCalls = functions.map(() => ({ invocations: take(), durationMs: take() }));
    const logBytes = functions.map(() => take());
    return {
      handlers: functions.map((handler, index) => ({
        stage: handler.stage,
        memoryMb: handler.configuration.MemorySize ?? 128,
        ...handlerCalls[index]!,
        logGroup: logGroupOf(handler),
        logBytes: logBytes[index]!,
        logStoredBytes: stored[index]!,
      })),
      queues: queues.map(({ stage, role }) => ({
        name: queueName(stage, role),
        stage,
        role,
        sent: take(),
        received: take(),
        deleted: take(),
        emptyReceives: take(),
      })),
      tables: tables.map(({ name: tableName, role }, index) => ({
        name: tableName,
        role,
        readUnits: take(),
        writeUnits: take(),
        sizeBytes: sizes[index]!,
      })),
      emailBytes,
    };
  }

  return {
    async read(windowHours) {
      const now = new Date();
      const window = windowOf(windowHours, now);
      const functions = readFunctions(lambda, deployment);
      const requestedBefore = metricsRequested;
      const [deploymentStatus, handlers, queues, buckets, orders, settings, logEvents, usage] = await Promise.all([
        section(deploymentStatusSource.read),
        section(async () => readHandlers(window, await functions)),
        section(() => readQueues(window)),
        section(() => readBuckets(s3, prefix)),
        section(() => readOrders(window)),
        section(readSettings),
        section(async () => readLogs(window, await functions)),
        section(async () => readUsage(window, await functions)),
      ]);
      // Two reads at once can count each other's metrics, but the cache of the server makes that rare.
      const metricsPerRead = metricsRequested - requestedBefore;
      return {
        deployment: name,
        region,
        ...(deployment.inboxAddress !== undefined && { inboxAddress: deployment.inboxAddress }),
        collectedAt: now.toISOString(),
        windowHours,
        deploymentStatus,
        handlers,
        queues,
        buckets,
        orders,
        settings,
        logs: logEvents,
        usage: usage.ok ? { ok: true, value: { ...usage.value, metricsPerRead } } : usage,
      };
    },
  };
}

const redrivePolicy = (raw: string | undefined): { readonly maxReceiveCount?: unknown } => {
  try {
    return JSON.parse(raw ?? '{}') as { readonly maxReceiveCount?: unknown };
  } catch {
    return {};
  }
};

/**
 * The limits of a queue in its attributes: how long it keeps a message, and, for a queue with a DLQ, how many receives
 * a message gets before it moves there.
 */
export function queueLimits(attributes: Partial<Record<string, string>>) {
  const receives = Number(redrivePolicy(attributes.RedrivePolicy).maxReceiveCount);
  return {
    retentionSeconds: Number(attributes.MessageRetentionPeriod ?? 0),
    ...(Number.isInteger(receives) && receives > 0 && { maxReceiveCount: receives }),
  };
}

/** A line of `logPattern`. It is an error or a warning, so a line of another level counts as a warning. */
export function toLogEvent(stage: StageName, timestamp: number | undefined, raw: string | undefined): LogEvent {
  const line = parseLine(raw ?? '');
  return {
    stage,
    time: new Date(timestamp ?? 0).toISOString(),
    level: line.level === 'error' ? 'error' : 'warn',
    ...(line.runID !== undefined && { requestId: line.runID }),
    message: line.message,
  };
}

import * as AWS from '@alchemy.run/aws';
import { lambdaBundle } from '@leads/lambda/bundle';
import { decodeRuntimeSettings, runtimeSettingsJsonSchema } from '@leads/pipeline/settings';
import { isOnFloci, type Deployment } from '@leads/shared/deployments';
import { handlerSettings, handlerTimeoutOf } from '@leads/shared/domain/handlerSettings';
import { queueSettings, visibilityTimeout } from '@leads/shared/domain/queueSettings';
import type { StageName } from '@leads/shared/domain/stages';
import { mailNames, resourceNames } from '@leads/shared/names';
import type { Input } from 'alchemy/Input';
import * as Output from 'alchemy/Output';
import * as RemovalPolicy from 'alchemy/RemovalPolicy';
import * as Data from 'effect/Data';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';

export interface LeadsPipelineOptions {
  /** The endpoint that the handlers in Floci call, as `FLOCI_ENDPOINT`. Only a Floci deployment sets it. */
  readonly lambdaEndpoint?: string;
  /** The folder of the Lambda bundle, with one subfolder for each stage. The default is the bundle of a real deployment. */
  readonly lambdaAssetDirectory?: string;
  /** More environment variables of each handler. The e2e app adds its own here. */
  readonly handlerEnvironment?: Readonly<Record<string, unknown>>;
}

/** The actions that the event source mapping of a queue needs on the role of its function. CDK adds them, Alchemy does not. */
const consumeActions = [
  'sqs:ReceiveMessage',
  'sqs:ChangeMessageVisibility',
  'sqs:GetQueueUrl',
  'sqs:DeleteMessage',
  'sqs:GetQueueAttributes',
];

/** The actions that sending to a queue needs: the role of a producer, and the queue policy for S3. */
const sendActions = ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'];

const bucketActions = {
  read: ['s3:GetObject', 's3:ListBucket'],
  write: ['s3:PutObject'],
  delete: ['s3:DeleteObject'],
} as const;

const bucketArn = (bucketName: string) => `arn:aws:s3:::${bucketName}`;

/** No policy or ACL can make an object of the bucket public. */
const blockAllPublicAccess = {
  blockPublicAcls: true,
  ignorePublicAcls: true,
  blockPublicPolicy: true,
  restrictPublicBuckets: true,
};

/** The statement of a bucket policy that refuses each request without TLS, as `enforceSSL` of CDK does. */
const tlsOnly = (bucketName: string) => ({
  Effect: 'Deny' as const,
  Principal: { AWS: '*' },
  Action: ['s3:*'],
  Resource: [bucketArn(bucketName), `${bucketArn(bucketName)}/*`],
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
});

const capitalize = (word: string) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

/**
 * The pipeline of `LeadsStack` (iac/cdk), made by Alchemy from the same contract and the same Lambda bundle. Each
 * resource takes its name from `resourceNames`, and each setting from the shared settings. It gives its three
 * handlers, so that an app can bind more to them, as the e2e app does. When the deployment has an `inboxAddress`, it
 * also receives email (see `receive`) and gives the DNS records of the domain as `mail`.
 */
export const leadsPipeline = (deployment: Deployment, options: LeadsPipelineOptions = {}) =>
  Effect.gen(function* () {
    yield* inTheTargetOf(deployment);
    const names = resourceNames(deployment.prefix);
    const onFloci = isOnFloci(deployment);
    // The CDK stack keeps the buckets and the tables of a real deployment when it is deleted (the CDK default).
    const keep = RemovalPolicy.retain(!onFloci);

    // A handler deletes each file that it processed or rejected, so the ledger is the only record of a handled request.
    const inbox = yield* AWS.S3.Bucket('Inbox', {
      bucketName: names.bucket('inbox'),
      forceDestroy: onFloci,
      publicAccessBlock: blockAllPublicAccess,
      // SES of this account stores the emails of the inbox address here.
      policy: [
        tlsOnly(names.bucket('inbox')),
        {
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: ['s3:PutObject'],
          Resource: [`${bucketArn(names.bucket('inbox'))}/*`],
          Condition: { StringEquals: { 'aws:SourceAccount': deployment.account } },
        },
      ],
    }).pipe(keep);
    const leadSources = yield* AWS.S3.Bucket('LeadSources', {
      bucketName: names.bucket('leadSources'),
      forceDestroy: onFloci,
      publicAccessBlock: blockAllPublicAccess,
      policy: [tlsOnly(names.bucket('leadSources'))],
    }).pipe(keep);

    // The key is the idempotency key of the lead, so the order repository stores each lead only once.
    const orders = yield* AWS.DynamoDB.Table('Orders', {
      tableName: names.ordersTable,
      partitionKey: 'idempotencyKey',
      attributes: { idempotencyKey: 'S' },
      billingMode: 'PAY_PER_REQUEST',
    }).pipe(keep);
    // The key is the SES message ID of the email, so the request ledger has one entry for each email.
    // TTL deletes an entry one week after its last change, so the scans of the lab stay small.
    const requestLedger = yield* AWS.DynamoDB.Table('RequestLedger', {
      tableName: names.requestLedgerTable,
      partitionKey: 'requestID',
      attributes: { requestID: 'S' },
      billingMode: 'PAY_PER_REQUEST',
      timeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' },
    }).pipe(keep);

    const runtimeSettings = yield* runtimeSettingsOf(deployment);

    // The stage queues keep the SQS default retention of four days, except where `queueSettings.retention` names one.
    const stageQueue = (id: string, stage: StageName) =>
      Effect.gen(function* () {
        const deadLetterQueue = yield* AWS.SQS.Queue(`${id}DeadLetterQueue`, {
          queueName: names.dlq(stage),
          messageRetentionPeriod: queueSettings.deadLetterRetention,
        });
        const retention: Partial<Record<StageName, number>> = queueSettings.retention;
        const retentionOfStage = retention[stage];
        // No consumer reads a dead-letter queue, so an alarm shows each message that reaches one.
        yield* AWS.CloudWatch.Alarm(`${id}DeadLetterAlarm`, {
          name: names.dlqAlarm(stage),
          AlarmDescription: `A message is in ${names.dlq(stage)}. Read it in the lab, then redrive it or delete it.`,
          Namespace: 'AWS/SQS',
          MetricName: 'ApproximateNumberOfMessagesVisible',
          Dimensions: [{ Name: 'QueueName', Value: names.dlq(stage) }],
          Statistic: 'Maximum',
          Period: 300,
          EvaluationPeriods: 1,
          Threshold: 1,
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          TreatMissingData: 'notBreaching',
        });
        return yield* AWS.SQS.Queue(`${id}Queue`, {
          queueName: names.queue(stage),
          visibilityTimeout: visibilityTimeout(handlerTimeoutOf[stage], queueSettings.mapping[stage].batchingWindow),
          ...(retentionOfStage !== undefined && { messageRetentionPeriod: retentionOfStage }),
          redrivePolicy: {
            deadLetterTargetArn: deadLetterQueue.queueArn,
            maxReceiveCount: queueSettings.maxReceiveCount,
          },
        });
      });

    const inboxQueue = yield* stageQueue('Inbox', 'inbox');
    const leadSourcesQueue = yield* stageQueue('LeadSources', 'leadSources');
    const leadsQueue = yield* stageQueue('Leads', 'leads');

    const handlerEnvironment = {
      LEAD_SOURCES_BUCKET_NAME: names.bucket('leadSources'),
      ORDERS_TABLE_NAME: orders.tableName,
      REQUEST_LEDGER_TABLE_NAME: requestLedger.tableName,
      APPCONFIG_APPLICATION_ID: runtimeSettings.applicationId,
      APPCONFIG_ENVIRONMENT_ID: runtimeSettings.environmentId,
      APPCONFIG_PROFILE_ID: runtimeSettings.configurationProfileId,
      ...(options.lambdaEndpoint !== undefined && { FLOCI_ENDPOINT: options.lambdaEndpoint }),
      ...options.handlerEnvironment,
    };
    const bundle = options.lambdaAssetDirectory ?? lambdaBundle.live;

    // The bundle of a stage is in the folder of the stage name. Alchemy deploys the folder as it is.
    const handler = (id: string, stage: StageName, extraEnvironment: Record<string, unknown> = {}) => {
      const memorySize = (handlerSettings.memorySize as Partial<Record<StageName, number>>)[stage];
      return AWS.Lambda.Function(id, {
        functionName: names.functionName(stage),
        main: `${bundle}/${stage}/index.js`,
        bundle: false,
        handler: 'handler',
        runtime: 'nodejs24.x',
        timeout: Duration.millis(handlerTimeoutOf[stage]),
        ...(memorySize !== undefined && { memorySize }),
        reservedConcurrentExecutions: handlerSettings.stageCaps[stage],
        env: { ...handlerEnvironment, ...extraEnvironment },
        // The queues invoke the handlers. A function URL would expose them.
        functionUrl: false,
        // Alchemy makes the log group before the first invocation, so it never keeps a log forever.
        logging: { retention: Duration.days(handlerSettings.logRetentionDays) },
      });
    };

    const inboxHandler = yield* handler('InboxHandler', 'inbox');
    const leadSourcesHandler = yield* handler('LeadSourcesHandler', 'leadSources', {
      LEADS_QUEUE_URL: leadsQueue.queueUrl,
    });
    // A batch holds at most ten leads, and the handler only stores them, so one minute is enough.
    const leadHandler = yield* handler('LeadHandler', 'leads');

    /** The event source mapping of a stage, from the shared queue settings. A window of 0 is the AWS default. */
    const consume = (id: string, stage: StageName, fn: AWS.Lambda.Function, queue: AWS.SQS.Queue) => {
      const { batchSize, batchingWindow, maxConcurrency } = queueSettings.mapping[stage];
      return AWS.Lambda.EventSourceMapping(`${id}Mapping`, {
        functionName: fn.functionName,
        eventSourceArn: queue.queueArn,
        batchSize,
        ...(batchingWindow > 0 && { maximumBatchingWindow: batchingWindow }),
        scalingConfig: { MaximumConcurrency: maxConcurrency },
        ...(stage === 'leads' && { functionResponseTypes: ['ReportBatchItemFailures' as const] }),
      });
    };

    yield* consume('Inbox', 'inbox', inboxHandler, inboxQueue);
    yield* consume('LeadSources', 'leadSources', leadSourcesHandler, leadSourcesQueue);
    yield* consume('Leads', 'leads', leadHandler, leadsQueue);

    /** One IAM statement on the role of a function, as one binding. */
    const allow = (
      fn: AWS.Lambda.Function,
      sid: string,
      { Action, Resource }: { readonly Action: string[]; readonly Resource: Input<string>[] }
    ) => fn.bind(sid, { policyStatements: [{ Sid: sid, Effect: 'Allow', Action, Resource }] });
    const allowOnBucket = (
      fn: AWS.Lambda.Function,
      action: keyof typeof bucketActions,
      stage: Exclude<StageName, 'leads'>
    ) =>
      allow(fn, `${capitalize(action)}${capitalize(stage)}Bucket`, {
        Action: [...bucketActions[action]],
        Resource: [bucketArn(names.bucket(stage)), `${bucketArn(names.bucket(stage))}/*`],
      });

    yield* allow(inboxHandler, 'ConsumeInboxQueue', { Action: consumeActions, Resource: [inboxQueue.queueArn] });
    yield* allow(leadSourcesHandler, 'ConsumeLeadSourcesQueue', {
      Action: consumeActions,
      Resource: [leadSourcesQueue.queueArn],
    });
    yield* allow(leadHandler, 'ConsumeLeadsQueue', { Action: consumeActions, Resource: [leadsQueue.queueArn] });

    yield* allow(leadSourcesHandler, 'SendToLeadsQueue', {
      Action: sendActions,
      Resource: [leadsQueue.queueArn],
    });

    for (const fn of [inboxHandler, leadSourcesHandler, leadHandler]) {
      yield* allow(fn, 'ReadRuntimeSettings', {
        Action: ['appconfig:GetLatestConfiguration', 'appconfig:StartConfigurationSession'],
        Resource: [runtimeSettings.configurationArn],
      });
    }

    yield* allowOnBucket(inboxHandler, 'read', 'inbox');
    yield* allowOnBucket(inboxHandler, 'delete', 'inbox');
    yield* allowOnBucket(inboxHandler, 'write', 'leadSources');

    yield* allowOnBucket(leadSourcesHandler, 'read', 'leadSources');
    yield* allowOnBucket(leadSourcesHandler, 'delete', 'leadSources');

    yield* allow(leadHandler, 'PutOrders', { Action: ['dynamodb:PutItem'], Resource: [orders.tableArn] });
    // Only the inbox handler puts a new entry. Every handler updates the progress of an entry.
    yield* allow(inboxHandler, 'WriteRequestLedger', {
      Action: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      Resource: [requestLedger.tableArn],
    });
    for (const fn of [leadSourcesHandler, leadHandler]) {
      yield* allow(fn, 'UpdateRequestLedger', { Action: ['dynamodb:UpdateItem'], Resource: [requestLedger.tableArn] });
    }

    yield* notify(inbox, inboxQueue);
    yield* notify(leadSources, leadSourcesQueue);

    const mail =
      deployment.inboxAddress === undefined
        ? undefined
        : yield* receive(deployment.inboxAddress, names.mailRule, inbox, deployment.region);

    return { handlers: [inboxHandler, leadSourcesHandler, leadHandler] as const, mail };
  });

/** Thrown when the inbox address of a deployment is not a lowercase email address. */
export class InvalidInboxAddress extends Data.TaggedError('InvalidInboxAddress')<{ readonly address: string }> {
  override get message() {
    return `Inbox address must be a lowercase email address: ${this.address}`;
  }
}

/**
 * Verifies the domain of the address with Easy DKIM, and adds the rule of the deployment to the shared rule set
 * `leads-mail`, as `LeadsStack.receive` of iac/cdk does. The rule stores each email to the address in the inbox bucket.
 * The mail stack owns `leads-mail` and its activation, so the rule set must exist before this stack adds its rule.
 * The DNS of the domain is not in Route 53, so the stack gives the DKIM and MX records to add by hand.
 */
const receive = (address: string, ruleName: string, inbox: AWS.S3.Bucket, region: string) =>
  Effect.gen(function* () {
    const domain = address.split('@').at(-1);
    if (domain === undefined || !/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(address)) {
      return yield* Effect.die(new InvalidInboxAddress({ address }));
    }

    // SES turns on Easy DKIM for a new domain identity, with its default key of 2048 bits.
    const identity = yield* AWS.SES.EmailIdentity('MailIdentity', { emailIdentity: domain });
    // No `after`: the rule goes to the top of `leads-mail`. No rule of the set stops the others, so the order of the
    // rules does not change which deployment receives an email.
    yield* AWS.SES.ReceiptRule('MailRule', {
      ruleSetName: mailNames.ruleSet,
      ruleName,
      recipients: [address],
      scanEnabled: true,
      actions: [{ S3Action: { BucketName: inbox.bucketName } }],
    });

    return {
      dkimRecords: Output.map(identity.dkimTokens, (tokens) =>
        tokens.map((token) => `CNAME ${token}._domainkey.${domain} ${token}.dkim.amazonses.com`)
      ),
      mxRecord: `MX ${domain} 10 inbound-smtp.${region}.amazonaws.com`,
    };
  });

/** Thrown when the providers reach an account or a Region that is not the one of the deployment. */
export class WrongTarget extends Data.TaggedError('WrongTarget')<{
  readonly expected: { readonly accountId: string; readonly region: string };
  readonly actual: { readonly accountId: string; readonly region: string };
}> {
  override get message() {
    const { expected, actual } = this;
    return `The deployment is in ${expected.accountId}/${expected.region}, but the providers reach ${actual.accountId}/${actual.region}. Check the Alchemy profile.`;
  }
}

/**
 * Fails unless the providers reach the account and the Region of the deployment. A real deployment takes them from the
 * Alchemy profile, and the stack writes them into the SES condition and the AppConfig ARN. The CDK app pins them too.
 */
const inTheTargetOf = (deployment: Deployment) =>
  Effect.gen(function* () {
    const { accountId, region } = yield* yield* AWS.AWSEnvironment;
    if (accountId === deployment.account && region === deployment.region) return;
    return yield* Effect.die(
      new WrongTarget({
        expected: { accountId: deployment.account, region: deployment.region },
        actual: { accountId, region },
      })
    );
  });

/**
 * Sends an event of each new object in the bucket to the queue: the queue policy lets S3 send, and the notification of
 * the bucket names the queue. The S3 event source of Alchemy binds the same two parts.
 */
const notify = (bucket: AWS.S3.Bucket, queue: AWS.SQS.Queue) =>
  Effect.gen(function* () {
    yield* queue.bind(`AllowS3EventsFrom${bucket.LogicalId}`, {
      policyStatements: [
        {
          Sid: `AllowS3EventsFrom${bucket.LogicalId}`,
          Effect: 'Allow',
          Principal: { Service: 's3.amazonaws.com' },
          Action: sendActions,
          Resource: [queue.queueArn],
          Condition: { ArnLike: { 'aws:SourceArn': bucket.bucketArn } },
        },
      ],
    });
    yield* bucket.bind(`NotifyQueue${queue.LogicalId}`, {
      notificationConfiguration: {
        QueueConfigurations: [{ QueueArn: queue.queueArn, Events: ['s3:ObjectCreated:*'] }],
      },
    });
  });

/**
 * Makes the AppConfig profile of the runtime settings and deploys the seed document to it at once. A new seed is a new
 * hosted version, so it replaces the deployment. AppConfig keeps each later deployment.
 */
const runtimeSettingsOf = (deployment: Deployment) =>
  Effect.gen(function* () {
    const names = resourceNames(deployment.prefix);
    const seed = decodeRuntimeSettings({
      INBOX_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.inbox,
      LEAD_SOURCES_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leadSources,
      LEAD_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leads,
      INBOX_SENDER_WHITELIST: deployment.senderWhitelist,
    });
    const application = yield* AWS.AppConfig.Application('RuntimeSettingsApplication', {
      applicationName: names.appConfigApplication,
    });
    const live = yield* AWS.AppConfig.Environment('RuntimeSettingsEnvironment', {
      applicationId: application.applicationId,
      environmentName: 'live',
    });
    const profile = yield* AWS.AppConfig.ConfigurationProfile('RuntimeSettingsConfigurationProfile', {
      applicationId: application.applicationId,
      configurationProfileName: 'runtime-settings',
      locationUri: 'hosted',
      type: 'AWS.Freeform',
      validators: [{ type: 'JSON_SCHEMA', content: JSON.stringify(runtimeSettingsJsonSchema()) }],
    });
    const seedVersion = yield* AWS.AppConfig.HostedConfigurationVersion('RuntimeSettings', {
      applicationId: application.applicationId,
      configurationProfileId: profile.configurationProfileId,
      content: JSON.stringify(seed),
      contentType: 'application/json',
    });
    // No alarm watches a rollout, so a slow rollout or a bake time only delays the change.
    const atOnce = yield* AWS.AppConfig.DeploymentStrategy('RuntimeSettingsRollout', {
      deploymentStrategyName: names.appConfigDeploymentStrategy,
      deploymentDuration: 0,
      growthFactor: 100,
      growthType: 'LINEAR',
      finalBakeTime: 0,
      replicateTo: 'NONE',
    });
    yield* AWS.AppConfig.Deployment('RuntimeSettingsDeployment', {
      applicationId: application.applicationId,
      environmentId: live.environmentId,
      deploymentStrategyId: atOnce.deploymentStrategyId,
      configurationProfileId: profile.configurationProfileId,
      configurationVersion: Output.map(seedVersion.versionNumber, String),
    });
    return {
      applicationId: application.applicationId,
      environmentId: live.environmentId,
      configurationProfileId: profile.configurationProfileId,
      /** The configurations of the `live` environment, which the handlers read. */
      configurationArn: Output.interpolate`arn:aws:appconfig:${deployment.region}:${deployment.account}:application/${application.applicationId}/environment/${live.environmentId}/configuration/*`,
    };
  });

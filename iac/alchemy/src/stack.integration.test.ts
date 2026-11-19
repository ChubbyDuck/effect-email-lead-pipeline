import { lambdaBundle } from '@leads/lambda/bundle';
import { runtimeSettingsJsonSchema } from '@leads/pipeline/settings';
import { deployments, type Deployment } from '@leads/shared/deployments';
import { handlerSettings, handlerTimeoutOf } from '@leads/shared/domain/handlerSettings';
import { queueSettings, visibilityTimeout } from '@leads/shared/domain/queueSettings';
import type { StageName } from '@leads/shared/domain/stages';
import { alchemyPipeline, mailNames, resourceNames } from '@leads/shared/names';
import * as Alchemy from 'alchemy';
import * as Alchemist from 'alchemy/Alchemist';
import * as Output from 'alchemy/Output';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import { beforeAll, describe, expect, test } from 'vitest';

import { leadsPipeline } from './stack';
import { flociProviders } from './target';

/**
 * The plan of the stack against the Floci image of Alchemy at `FLOCI_ENDPOINT`, with in-memory state: what a first
 * deploy makes. The plan applies nothing. `LeadsStack` of iac/cdk is the reference of each setting. The providers reach
 * the account and the Region of `target`, which is the deployment itself unless a test changes it.
 */
const planOf = (name: 'e2e-alchemy' | 'production-alchemy', target: Deployment = deployments[name]) => {
  const deployment = deployments[name];
  return Effect.runPromise(
    Alchemist.plan({
      stack: Alchemy.Stack(
        alchemyPipeline.stack,
        { providers: flociProviders(target, flociEndpoint()), state: Alchemy.inMemoryState() },
        leadsPipeline(deployment)
      ),
      operation: 'deploy',
      stage: alchemyPipeline.stage(name),
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped)
  );
};

function flociEndpoint(): string {
  const endpoint = process.env.FLOCI_ENDPOINT;
  if (endpoint === undefined) throw new Error('Set FLOCI_ENDPOINT to the endpoint of a Floci image of Alchemy');
  return endpoint;
}

/**
 * A planned value with each reference to a different resource written as `<LogicalId.attribute>`. A derived value,
 * such as an ARN made with `Output.interpolate`, is computed from these placeholders.
 */
function shown(value: unknown): unknown {
  if (Output.isOutput(value)) {
    if (Output.isPropExpr(value) && Output.isResourceExpr(value.expr)) {
      return `<${value.expr.src.LogicalId}.${String(value.identifier)}>`;
    }
    if (Output.isLiteralExpr(value)) return value.value;
    if (Output.isAllExpr(value)) return value.outs.map(shown);
    if (Output.isApplyExpr(value)) return value.f(shown(value.expr));
    throw new Error(`An output that the test cannot show: ${value.kind}`);
  }
  if (Array.isArray(value)) return value.map(shown);
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shown(entry)]));
  }
  return value;
}

type Plan = Awaited<ReturnType<typeof planOf>>;

/** The planned resource `logicalId`: its type, its action, its props, its removal policy, and its bindings by SID. */
function planned(plan: Plan, logicalId: string) {
  const node = plan.native.resources[logicalId];
  if (node === undefined) throw new Error(`The plan has no resource ${logicalId}`);
  return {
    type: node.resource.Type,
    action: node.action,
    removalPolicy: node.resource.RemovalPolicy,
    props: shown('props' in node ? node.props : undefined) as Record<string, unknown>,
    bindings: Object.fromEntries(node.bindings.map((binding) => [binding.sid, shown(binding.data)])),
  };
}

const deployment = deployments['e2e-alchemy'];
const names = resourceNames(deployment.prefix);
let plan: Plan;

beforeAll(async () => {
  plan = await planOf('e2e-alchemy');
}, 120_000);

const stages = [
  { stage: 'inbox', id: 'Inbox', handler: 'InboxHandler' },
  { stage: 'leadSources', id: 'LeadSources', handler: 'LeadSourcesHandler' },
  { stage: 'leads', id: 'Leads', handler: 'LeadHandler' },
] as const satisfies readonly { stage: StageName; id: string; handler: string }[];

const runtimeSettingsArn =
  `arn:aws:appconfig:${deployment.region}:${deployment.account}:application/` +
  '<RuntimeSettingsApplication.applicationId>/environment/<RuntimeSettingsEnvironment.environmentId>/configuration/*';
const publicAccessBlock = {
  blockPublicAcls: true,
  ignorePublicAcls: true,
  blockPublicPolicy: true,
  restrictPublicBuckets: true,
};
const bucketArns = (stage: 'inbox' | 'leadSources') => [
  `arn:aws:s3:::${names.bucket(stage)}`,
  `arn:aws:s3:::${names.bucket(stage)}/*`,
];
const consumeActions = [
  'sqs:ReceiveMessage',
  'sqs:ChangeMessageVisibility',
  'sqs:GetQueueUrl',
  'sqs:DeleteMessage',
  'sqs:GetQueueAttributes',
];
const allow = (Sid: string, Action: string[], Resource: string[]) => ({
  policyStatements: [{ Sid, Effect: 'Allow', Action, Resource }],
});

test('plans every resource of LeadsStack except SES in a deployment without an inbox address, each one new', () => {
  const resources = Object.fromEntries(Object.keys(plan.native.resources).map((id) => [id, planned(plan, id).type]));

  expect(resources).toEqual({
    Inbox: 'AWS.S3.Bucket',
    LeadSources: 'AWS.S3.Bucket',
    Orders: 'AWS.DynamoDB.Table',
    RequestLedger: 'AWS.DynamoDB.Table',
    InboxQueue: 'AWS.SQS.Queue',
    InboxDeadLetterQueue: 'AWS.SQS.Queue',
    LeadSourcesQueue: 'AWS.SQS.Queue',
    LeadSourcesDeadLetterQueue: 'AWS.SQS.Queue',
    LeadsQueue: 'AWS.SQS.Queue',
    LeadsDeadLetterQueue: 'AWS.SQS.Queue',
    InboxDeadLetterAlarm: 'AWS.CloudWatch.Alarm',
    LeadSourcesDeadLetterAlarm: 'AWS.CloudWatch.Alarm',
    LeadsDeadLetterAlarm: 'AWS.CloudWatch.Alarm',
    InboxHandler: 'AWS.Lambda.Function',
    LeadSourcesHandler: 'AWS.Lambda.Function',
    LeadHandler: 'AWS.Lambda.Function',
    InboxMapping: 'AWS.Lambda.EventSourceMapping',
    LeadSourcesMapping: 'AWS.Lambda.EventSourceMapping',
    LeadsMapping: 'AWS.Lambda.EventSourceMapping',
    RuntimeSettingsApplication: 'AWS.AppConfig.Application',
    RuntimeSettingsEnvironment: 'AWS.AppConfig.Environment',
    RuntimeSettingsConfigurationProfile: 'AWS.AppConfig.ConfigurationProfile',
    RuntimeSettings: 'AWS.AppConfig.HostedConfigurationVersion',
    RuntimeSettingsRollout: 'AWS.AppConfig.DeploymentStrategy',
    RuntimeSettingsDeployment: 'AWS.AppConfig.Deployment',
  });
  expect(new Set(Object.values(plan.native.resources).map((node) => node.action))).toEqual(new Set(['create']));
});

test('refuses to plan when the providers reach a different Region than the one of the deployment', async () => {
  await expect(planOf('e2e-alchemy', { ...deployment, region: 'eu-west-1' })).rejects.toThrow(
    `The deployment is in ${deployment.account}/${deployment.region}, but the providers reach ${deployment.account}/eu-west-1`
  );
}, 120_000);

describe('the buckets', () => {
  test('lets SES of the account put an email into the inbox bucket, and destroys both buckets with their objects', () => {
    expect(planned(plan, 'Inbox').props).toEqual({
      bucketName: names.bucket('inbox'),
      forceDestroy: true,
      publicAccessBlock,
      policy: [
        {
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Action: ['s3:*'],
          Resource: bucketArns('inbox'),
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
        {
          Effect: 'Allow',
          Principal: { Service: 'ses.amazonaws.com' },
          Action: ['s3:PutObject'],
          Resource: [`arn:aws:s3:::${names.bucket('inbox')}/*`],
          Condition: { StringEquals: { 'aws:SourceAccount': deployment.account } },
        },
      ],
    });
    expect(planned(plan, 'LeadSources').props).toEqual({
      bucketName: names.bucket('leadSources'),
      forceDestroy: true,
      publicAccessBlock,
      policy: [
        {
          Effect: 'Deny',
          Principal: { AWS: '*' },
          Action: ['s3:*'],
          Resource: bucketArns('leadSources'),
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        },
      ],
    });
  });

  test.each(stages.filter(({ stage }) => stage !== 'leads'))(
    'sends each new object of the $stage bucket to its queue',
    ({ id }) => {
      expect(planned(plan, id).bindings).toEqual({
        [`NotifyQueue${id}Queue`]: {
          notificationConfiguration: {
            QueueConfigurations: [{ QueueArn: `<${id}Queue.queueArn>`, Events: ['s3:ObjectCreated:*'] }],
          },
        },
      });
      expect(planned(plan, `${id}Queue`).bindings).toEqual({
        [`AllowS3EventsFrom${id}`]: {
          policyStatements: [
            {
              Sid: `AllowS3EventsFrom${id}`,
              Effect: 'Allow',
              Principal: { Service: 's3.amazonaws.com' },
              Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
              Resource: [`<${id}Queue.queueArn>`],
              Condition: { ArnLike: { 'aws:SourceArn': `<${id}.bucketArn>` } },
            },
          ],
        },
      });
    }
  );
});

test('keys the orders by idempotency key and the ledger by request ID, on demand, with the TTL of the ledger', () => {
  expect(planned(plan, 'Orders').props).toEqual({
    tableName: names.ordersTable,
    partitionKey: 'idempotencyKey',
    attributes: { idempotencyKey: 'S' },
    billingMode: 'PAY_PER_REQUEST',
  });
  expect(planned(plan, 'RequestLedger').props).toEqual({
    tableName: names.requestLedgerTable,
    partitionKey: 'requestID',
    attributes: { requestID: 'S' },
    billingMode: 'PAY_PER_REQUEST',
    timeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' },
  });
});

test.each(stages)(
  'gives the $stage queue its visibility, its retention, and its dead-letter queue',
  ({ stage, id }) => {
    const retention: Partial<Record<StageName, number>> = queueSettings.retention;

    expect(planned(plan, `${id}Queue`).props).toEqual({
      queueName: names.queue(stage),
      visibilityTimeout: visibilityTimeout(handlerTimeoutOf[stage], queueSettings.mapping[stage].batchingWindow),
      ...(retention[stage] !== undefined && { messageRetentionPeriod: retention[stage] }),
      redrivePolicy: {
        deadLetterTargetArn: `<${id}DeadLetterQueue.queueArn>`,
        maxReceiveCount: queueSettings.maxReceiveCount,
      },
    });
    expect(planned(plan, `${id}DeadLetterQueue`).props).toEqual({
      queueName: names.dlq(stage),
      messageRetentionPeriod: queueSettings.deadLetterRetention,
    });
  }
);

test.each(stages)('raises an alarm when the $stage DLQ holds a message', ({ stage, id }) => {
  expect(planned(plan, `${id}DeadLetterAlarm`).props).toEqual({
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
});

test.each(stages)(
  'deploys the prebuilt bundle of the $stage handler with the settings of LeadsStack',
  ({ stage, handler }) => {
    const { timeout, logging, ...props } = planned(plan, handler).props;
    const memorySize = (handlerSettings.memorySize as Partial<Record<StageName, number>>)[stage];

    expect(Duration.toMillis(timeout as Duration.Duration)).toBe(handlerTimeoutOf[stage]);
    expect(Duration.toDays((logging as { retention: Duration.Duration }).retention)).toBe(
      handlerSettings.logRetentionDays
    );
    expect(props).toEqual({
      functionName: names.functionName(stage),
      main: `${lambdaBundle.live}/${stage}/index.js`,
      bundle: false,
      handler: 'handler',
      runtime: 'nodejs24.x',
      ...(memorySize !== undefined && { memorySize }),
      reservedConcurrentExecutions: handlerSettings.stageCaps[stage],
      env: {
        LEAD_SOURCES_BUCKET_NAME: names.bucket('leadSources'),
        ORDERS_TABLE_NAME: '<Orders.tableName>',
        REQUEST_LEDGER_TABLE_NAME: '<RequestLedger.tableName>',
        APPCONFIG_APPLICATION_ID: '<RuntimeSettingsApplication.applicationId>',
        APPCONFIG_ENVIRONMENT_ID: '<RuntimeSettingsEnvironment.environmentId>',
        APPCONFIG_PROFILE_ID: '<RuntimeSettingsConfigurationProfile.configurationProfileId>',
        ...(stage === 'leadSources' && { LEADS_QUEUE_URL: '<LeadsQueue.queueUrl>' }),
      },
      functionUrl: false,
      isExternal: true,
    });
  }
);

test.each(stages)('maps the $stage queue to its handler with the shared batch settings', ({ stage, id, handler }) => {
  const { batchSize, batchingWindow, maxConcurrency } = queueSettings.mapping[stage];

  expect(planned(plan, `${id}Mapping`).props).toEqual({
    functionName: `<${handler}.functionName>`,
    eventSourceArn: `<${id}Queue.queueArn>`,
    batchSize,
    ...(batchingWindow > 0 && { maximumBatchingWindow: batchingWindow }),
    scalingConfig: { MaximumConcurrency: maxConcurrency },
    ...(stage === 'leads' && { functionResponseTypes: ['ReportBatchItemFailures'] }),
  });
});

describe('the IAM statements of LeadsStack, with the SQS permissions of each mapping', () => {
  test('lets the inbox handler read and delete the inbox, write the lead sources, and put a ledger entry', () => {
    expect(planned(plan, 'InboxHandler').bindings).toEqual({
      ConsumeInboxQueue: allow('ConsumeInboxQueue', consumeActions, ['<InboxQueue.queueArn>']),
      ReadRuntimeSettings: allow(
        'ReadRuntimeSettings',
        ['appconfig:GetLatestConfiguration', 'appconfig:StartConfigurationSession'],
        [runtimeSettingsArn]
      ),
      ReadInboxBucket: allow('ReadInboxBucket', ['s3:GetObject', 's3:ListBucket'], bucketArns('inbox')),
      DeleteInboxBucket: allow('DeleteInboxBucket', ['s3:DeleteObject'], bucketArns('inbox')),
      WriteLeadSourcesBucket: allow('WriteLeadSourcesBucket', ['s3:PutObject'], bucketArns('leadSources')),
      WriteRequestLedger: allow(
        'WriteRequestLedger',
        ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
        ['<RequestLedger.tableArn>']
      ),
    });
  });

  test('lets the lead-sources handler read and delete the lead sources, send leads, and update the ledger', () => {
    expect(planned(plan, 'LeadSourcesHandler').bindings).toEqual({
      ConsumeLeadSourcesQueue: allow('ConsumeLeadSourcesQueue', consumeActions, ['<LeadSourcesQueue.queueArn>']),
      SendToLeadsQueue: allow(
        'SendToLeadsQueue',
        ['sqs:SendMessage', 'sqs:GetQueueAttributes', 'sqs:GetQueueUrl'],
        ['<LeadsQueue.queueArn>']
      ),
      ReadRuntimeSettings: allow(
        'ReadRuntimeSettings',
        ['appconfig:GetLatestConfiguration', 'appconfig:StartConfigurationSession'],
        [runtimeSettingsArn]
      ),
      ReadLeadSourcesBucket: allow(
        'ReadLeadSourcesBucket',
        ['s3:GetObject', 's3:ListBucket'],
        bucketArns('leadSources')
      ),
      DeleteLeadSourcesBucket: allow('DeleteLeadSourcesBucket', ['s3:DeleteObject'], bucketArns('leadSources')),
      UpdateRequestLedger: allow('UpdateRequestLedger', ['dynamodb:UpdateItem'], ['<RequestLedger.tableArn>']),
    });
  });

  test('lets the lead handler put an order and update the ledger', () => {
    expect(planned(plan, 'LeadHandler').bindings).toEqual({
      ConsumeLeadsQueue: allow('ConsumeLeadsQueue', consumeActions, ['<LeadsQueue.queueArn>']),
      ReadRuntimeSettings: allow(
        'ReadRuntimeSettings',
        ['appconfig:GetLatestConfiguration', 'appconfig:StartConfigurationSession'],
        [runtimeSettingsArn]
      ),
      PutOrders: allow('PutOrders', ['dynamodb:PutItem'], ['<Orders.tableArn>']),
      UpdateRequestLedger: allow('UpdateRequestLedger', ['dynamodb:UpdateItem'], ['<RequestLedger.tableArn>']),
    });
  });
});

test('deploys the seed of the runtime settings to the live environment at once, behind the JSON Schema validator', () => {
  expect(planned(plan, 'RuntimeSettingsApplication').props).toEqual({ applicationName: names.appConfigApplication });
  expect(planned(plan, 'RuntimeSettingsEnvironment').props).toEqual({
    applicationId: '<RuntimeSettingsApplication.applicationId>',
    environmentName: 'live',
  });
  expect(planned(plan, 'RuntimeSettingsConfigurationProfile').props).toEqual({
    applicationId: '<RuntimeSettingsApplication.applicationId>',
    configurationProfileName: 'runtime-settings',
    locationUri: 'hosted',
    type: 'AWS.Freeform',
    validators: [{ type: 'JSON_SCHEMA', content: JSON.stringify(runtimeSettingsJsonSchema()) }],
  });
  const seed = planned(plan, 'RuntimeSettings').props;
  expect(seed).toMatchObject({
    applicationId: '<RuntimeSettingsApplication.applicationId>',
    configurationProfileId: '<RuntimeSettingsConfigurationProfile.configurationProfileId>',
    contentType: 'application/json',
  });
  expect(JSON.parse(seed.content as string)).toEqual({
    INBOX_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.inbox,
    LEAD_SOURCES_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leadSources,
    LEAD_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leads,
    INBOX_SENDER_WHITELIST: deployment.senderWhitelist,
  });
  expect(planned(plan, 'RuntimeSettingsRollout').props).toEqual({
    deploymentStrategyName: names.appConfigDeploymentStrategy,
    deploymentDuration: 0,
    growthFactor: 100,
    growthType: 'LINEAR',
    finalBakeTime: 0,
    replicateTo: 'NONE',
  });
  expect(planned(plan, 'RuntimeSettingsDeployment').props).toEqual({
    applicationId: '<RuntimeSettingsApplication.applicationId>',
    environmentId: '<RuntimeSettingsEnvironment.environmentId>',
    deploymentStrategyId: '<RuntimeSettingsRollout.deploymentStrategyId>',
    configurationProfileId: '<RuntimeSettingsConfigurationProfile.configurationProfileId>',
    configurationVersion: '<RuntimeSettings.versionNumber>',
  });
});

describe('the email of production-alchemy', () => {
  // The plan of production-alchemy also runs against Floci. It reads no resource of the real deployment.
  const production = deployments['production-alchemy'];
  const productionNames = resourceNames(production.prefix);
  const domain = 'alchemy.ses.example.com';
  let productionPlan: Plan;

  beforeAll(async () => {
    productionPlan = await planOf('production-alchemy');
  }, 120_000);

  test('verifies the domain of the inbox address with Easy DKIM', () => {
    expect(planned(productionPlan, 'MailIdentity')).toMatchObject({
      type: 'AWS.SES.EmailIdentity',
      action: 'create',
      removalPolicy: 'destroy',
      props: { emailIdentity: domain },
    });
  });

  test('adds one rule to leads-mail that scans each email to the address and stores it in the inbox bucket', () => {
    expect(planned(productionPlan, 'MailRule')).toMatchObject({
      type: 'AWS.SES.ReceiptRule',
      action: 'create',
      removalPolicy: 'destroy',
    });
    expect(planned(productionPlan, 'MailRule').props).toEqual({
      ruleSetName: mailNames.ruleSet,
      ruleName: productionNames.mailRule,
      recipients: [production.inboxAddress],
      scanEnabled: true,
      actions: [{ S3Action: { BucketName: '<Inbox.bucketName>' } }],
    });
  });

  test('gives the DKIM CNAMEs and the MX record of the domain to add by hand', () => {
    const { mail } = productionPlan.native.output;
    if (mail === undefined) throw new Error('The plan of production-alchemy has no mail records');
    const { dkimRecords } = mail;
    if (!Output.isApplyExpr<string[], string[]>(dkimRecords))
      throw new Error('The DKIM records are not computed from the DKIM tokens');

    expect(shown(dkimRecords.expr)).toBe('<MailIdentity.dkimTokens>');
    expect(dkimRecords.f(['token1', 'token2'])).toEqual([
      `CNAME token1._domainkey.${domain} token1.dkim.amazonses.com`,
      `CNAME token2._domainkey.${domain} token2.dkim.amazonses.com`,
    ]);
    expect(mail.mxRecord).toBe(`MX ${domain} 10 inbound-smtp.${production.region}.amazonaws.com`);
  });

  test('receives no email in a deployment without an inbox address', () => {
    expect(plan.native.resources.MailIdentity).toBeUndefined();
    expect(plan.native.resources.MailRule).toBeUndefined();
    expect(plan.native.output.mail).toBeUndefined();
  });
});

describe('the removal of a deployment', () => {
  const kept = ['Inbox', 'LeadSources', 'Orders', 'RequestLedger'];

  test('destroys every resource of a Floci deployment', () => {
    const policies = new Set(Object.keys(plan.native.resources).map((id) => planned(plan, id).removalPolicy));

    expect(policies).toEqual(new Set(['destroy']));
  });

  test('keeps the buckets and the tables of production-alchemy, with the objects of the buckets', async () => {
    // The plan of production-alchemy also runs against Floci. It reads no resource of the real deployment.
    const production = await planOf('production-alchemy');
    const policies = Object.fromEntries(
      Object.keys(production.native.resources).map((id) => [id, planned(production, id).removalPolicy])
    );

    expect(Object.entries(policies).flatMap(([id, policy]) => (policy === 'retain' ? [id] : []))).toEqual(kept);
    expect(planned(production, 'Inbox').props.forceDestroy).toBe(false);
    expect(planned(production, 'LeadSources').props.forceDestroy).toBe(false);
  }, 120_000);
});

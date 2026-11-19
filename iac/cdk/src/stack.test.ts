import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runtimeSettingsJsonSchema } from '@leads/pipeline/settings';
import { handlerSettings } from '@leads/shared/domain/handlerSettings';
import { orderWritesPerSecond } from '@leads/shared/domain/orderWrites';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Code } from 'aws-cdk-lib/aws-lambda';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { LeadsStack } from './stack';

const props = { bucketPrefix: 'leads-test', senderWhitelist: ['owner@example.com'] };
const fromAsset = Code.fromAsset;
let assetDirectory: string;

beforeEach(() => {
  // Test the deployment wiring without requiring prebuilt Lambda bundle assets.
  assetDirectory = mkdtempSync(path.join(tmpdir(), 'leads-stack-test-'));
  writeFileSync(path.join(assetDirectory, 'index.js'), 'exports.handler = async () => {};');
  vi.spyOn(Code, 'fromAsset').mockImplementation(() => fromAsset(assetDirectory));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(assetDirectory, { recursive: true, force: true });
});

test.each([
  { suffix: 'inbox', handlerId: 'InboxHandler', timeout: 60 },
  { suffix: 'lead-sources', handlerId: 'LeadSourcesHandler', timeout: 300 },
])(
  'routes $suffix through SQS with one message per invocation and a 50-execution ceiling',
  ({ suffix, handlerId, timeout }) => {
    const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
    const [queueId] = Object.keys(
      template.findResources('AWS::SQS::Queue', { Properties: { QueueName: `leads-test-${suffix}` } })
    );
    const [bucketId] = Object.keys(
      template.findResources('AWS::S3::Bucket', { Properties: { BucketName: `leads-test-${suffix}` } })
    );
    const queueArn = { 'Fn::GetAtt': [queueId, 'Arn'] };

    expect(
      Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { ReservedConcurrentExecutions: 50 } }))
    ).toHaveLength(2);

    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: queueArn,
      BatchSize: 1,
      ScalingConfig: { MaximumConcurrency: 50 },
      FunctionName: { Ref: Match.stringLikeRegexp(`${handlerId}.*`) },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      ReservedConcurrentExecutions: 50,
      Timeout: timeout,
    });
    template.hasResourceProperties('Custom::S3BucketNotifications', {
      BucketName: { Ref: bucketId },
      NotificationConfiguration: {
        QueueConfigurations: [{ Events: ['s3:ObjectCreated:*'], QueueArn: queueArn }],
        LambdaFunctionConfigurations: Match.absent(),
      },
    });
    template.hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:SendMessage']),
            Principal: { Service: 's3.amazonaws.com' },
            Resource: queueArn,
            Condition: { ArnLike: { 'aws:SourceArn': { 'Fn::GetAtt': [bucketId, 'Arn'] } } },
          }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['sqs:ReceiveMessage', 'sqs:DeleteMessage']),
            Resource: queueArn,
          }),
        ]),
      },
    });
    template.resourceCountIs('AWS::Lambda::Permission', 0);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 3);
    template.resourceCountIs('AWS::S3::Bucket', 2);
  }
);

test.each([
  { suffix: 'inbox', visibilityTimeout: 90 },
  { suffix: 'lead-sources', visibilityTimeout: 330 },
  { suffix: 'leads', visibilityTimeout: 100 },
])(
  'keeps $suffix runtime failures queued with sufficient visibility and a dead-letter destination',
  ({ suffix, visibilityTimeout }) => {
    const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
    const [dlqId] = Object.keys(
      template.findResources('AWS::SQS::Queue', { Properties: { QueueName: `leads-test-${suffix}-dlq` } })
    );

    expect(Object.keys(template.findResources('AWS::SQS::Queue'))).toHaveLength(6);

    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: `leads-test-${suffix}`,
      VisibilityTimeout: visibilityTimeout,
      RedrivePolicy: { deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] }, maxReceiveCount: 1 },
    });
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: `leads-test-${suffix}-dlq`,
      MessageRetentionPeriod: 14 * 24 * 60 * 60,
    });
    expect(Object.values(template.findResources('AWS::Lambda::EventSourceMapping'))).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Properties: expect.objectContaining({ EventSourceArn: { 'Fn::GetAtt': [dlqId, 'Arn'] } }),
        }),
      ])
    );
  }
);

test.each([
  { suffix: 'inbox', role: 'InboxHandler' },
  { suffix: 'lead-sources', role: 'LeadSourcesHandler' },
  { suffix: 'leads', role: 'LeadHandler' },
])('lets $role release a failed message of $suffix at once', ({ suffix, role }) => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
  const [queueId] = Object.keys(
    template.findResources('AWS::SQS::Queue', { Properties: { QueueName: `leads-test-${suffix}` } })
  );
  expect(queueId).toBeDefined();
  template.hasResourceProperties('AWS::IAM::Policy', {
    Roles: [{ Ref: Match.stringLikeRegexp(`^${role}ServiceRole.*`) }],
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['sqs:ChangeMessageVisibility', 'sqs:GetQueueUrl']),
          Resource: { 'Fn::GetAtt': [queueId, 'Arn'] },
        }),
      ]),
    },
  });
});

test('connects LeadsQueue to LeadHandler with batches of ten, a 10-second window, and a 200-execution ceiling', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
  const [queueId] = Object.keys(
    template.findResources('AWS::SQS::Queue', {
      Properties: { QueueName: 'leads-test-leads' },
    })
  );
  const queueArn = { 'Fn::GetAtt': [queueId, 'Arn'] };
  template.hasResourceProperties('AWS::Lambda::Function', {
    Timeout: 300,
    Environment: { Variables: { LEADS_QUEUE_URL: { Ref: queueId } } },
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    Roles: [{ Ref: Match.stringLikeRegexp('LeadSourcesHandlerServiceRole.*') }],
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['sqs:SendMessage']),
          Resource: queueArn,
        }),
      ]),
    },
  });
  expect(Object.keys(template.findResources('AWS::Lambda::EventSourceMapping'))).toHaveLength(3);
  template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
    EventSourceArn: queueArn,
    FunctionName: { Ref: Match.stringLikeRegexp('LeadHandler.*') },
    BatchSize: 10,
    MaximumBatchingWindowInSeconds: 10,
    ScalingConfig: { MaximumConcurrency: 200 },
    FunctionResponseTypes: ['ReportBatchItemFailures'],
  });
  template.hasResourceProperties('AWS::Lambda::Function', {
    ReservedConcurrentExecutions: 200,
    Timeout: 60,
  });
  template.hasResourceProperties('AWS::SQS::Queue', {
    QueueName: 'leads-test-leads',
    VisibilityTimeout: 100,
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    Roles: [{ Ref: Match.stringLikeRegexp('LeadHandlerServiceRole.*') }],
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['sqs:ReceiveMessage', 'sqs:DeleteMessage']),
          Resource: queueArn,
        }),
      ]),
    },
  });
  template.resourceCountIs('AWS::Lambda::EventSourceMapping', 3);
  template.resourceCountIs('Custom::S3BucketNotifications', 2);
  template.resourceCountIs('AWS::Lambda::Permission', 0);
});

// The reserved concurrency of LeadHandler is its stage cap, so the lead handlers that run at once never get more
// buckets of order writes than the order write limit allows.
test('keeps the order writes of the leads stage at or below the order write limit', () => {
  expect(handlerSettings.stageCaps.leads * orderWritesPerSecond.environment).toBeLessThanOrEqual(
    orderWritesPerSecond.stack
  );
});

test('gives LeadSourcesHandler the measured memory', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));

  template.hasResourceProperties('AWS::Lambda::Function', { Timeout: 300, MemorySize: 1536 });
  expect(
    Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { MemorySize: 1536 } }))
  ).toHaveLength(1);
});

test('deploys the seed runtime settings to AppConfig at once, with the generated validator', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
  const [applicationId] = Object.keys(template.findResources('AWS::AppConfig::Application'));
  const [environmentId] = Object.keys(template.findResources('AWS::AppConfig::Environment'));
  const [profileId] = Object.keys(template.findResources('AWS::AppConfig::ConfigurationProfile'));
  const [strategyId] = Object.keys(template.findResources('AWS::AppConfig::DeploymentStrategy'));
  const versions = Object.entries(template.findResources('AWS::AppConfig::HostedConfigurationVersion'));

  template.hasResourceProperties('AWS::AppConfig::Application', { Name: 'leads-test' });
  template.hasResourceProperties('AWS::AppConfig::Environment', {
    ApplicationId: { Ref: applicationId },
    Name: 'live',
  });
  template.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
    ApplicationId: { Ref: applicationId },
    Name: 'runtime-settings',
    LocationUri: 'hosted',
    Type: 'AWS.Freeform',
    Validators: [{ Type: 'JSON_SCHEMA', Content: JSON.stringify(runtimeSettingsJsonSchema()) }],
  });
  template.hasResourceProperties('AWS::AppConfig::DeploymentStrategy', {
    Name: 'leads-test-at-once',
    GrowthType: 'LINEAR',
    GrowthFactor: 100,
    DeploymentDurationInMinutes: 0,
    FinalBakeTimeInMinutes: 0,
    ReplicateTo: 'NONE',
  });
  expect(versions).toHaveLength(1);
  const [versionId, version] = versions[0]!;
  expect(version.Properties).toMatchObject({ ApplicationId: { Ref: applicationId }, ContentType: 'application/json' });
  expect(JSON.parse(version.Properties.Content as string)).toEqual({
    INBOX_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.inbox,
    LEAD_SOURCES_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leadSources,
    LEAD_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leads,
    INBOX_SENDER_WHITELIST: ['owner@example.com'],
  });
  template.resourceCountIs('AWS::AppConfig::Deployment', 1);
  template.hasResourceProperties('AWS::AppConfig::Deployment', {
    ApplicationId: { Ref: applicationId },
    EnvironmentId: { Ref: environmentId },
    ConfigurationProfileId: { Ref: profileId },
    ConfigurationVersion: { Ref: versionId },
    DeploymentStrategyId: { Ref: strategyId },
  });
});

test('names the AppConfig profile on each handler and lets it read only that environment', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
  const [applicationId] = Object.keys(template.findResources('AWS::AppConfig::Application'));
  const [environmentId] = Object.keys(template.findResources('AWS::AppConfig::Environment'));
  const [profileId] = Object.keys(template.findResources('AWS::AppConfig::ConfigurationProfile'));
  const handlers = Object.values(
    template.findResources('AWS::Lambda::Function', { Properties: { Handler: 'index.handler', Runtime: 'nodejs24.x' } })
  );

  expect(handlers).toHaveLength(3);
  for (const handler of handlers) {
    const variables = (handler.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({
      APPCONFIG_APPLICATION_ID: { Ref: applicationId },
      APPCONFIG_ENVIRONMENT_ID: { Ref: environmentId },
      APPCONFIG_PROFILE_ID: { Ref: profileId },
    });
    // The runtime settings come from AppConfig, so the deployment does not fix them in the environment.
    for (const key of Object.keys(runtimeSettingsJsonSchema().properties ?? {}))
      expect(variables).not.toHaveProperty(key);
  }
  const grants = Object.values(
    template.findResources('AWS::IAM::Policy', {
      Properties: {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: ['appconfig:GetLatestConfiguration', 'appconfig:StartConfigurationSession'] }),
          ]),
        },
      },
    })
  );
  expect(grants).toHaveLength(3);
  expect(JSON.stringify(grants)).toContain(`"Ref":"${environmentId}"},"/configuration/*"`);
});

test('refuses a seed whitelist that the AppConfig validator would refuse', () => {
  expect(() => new LeadsStack(new App(), 'TestLeads', { ...props, senderWhitelist: ['not an address'] })).toThrow(
    'INBOX_SENDER_WHITELIST'
  );
});

test('makes exactly the orders table and the request ledger table', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));

  expect(
    Object.values(template.findResources('AWS::DynamoDB::Table')).map((table) => table.Properties.TableName)
  ).toEqual(['leads-test-orders', 'leads-test-request-ledger']);
});

test('deletes a ledger entry by TTL, but keeps every order', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
  const ttlOf = (table: string) =>
    Object.values(template.findResources('AWS::DynamoDB::Table', { Properties: { TableName: table } }))[0]?.Properties
      .TimeToLiveSpecification;

  expect(ttlOf('leads-test-request-ledger')).toEqual({ AttributeName: 'expiresAt', Enabled: true });
  expect(ttlOf('leads-test-orders')).toBeUndefined();
});

test.each([
  {
    records: 'orders',
    table: 'leads-test-orders',
    key: 'idempotencyKey',
    variable: 'ORDERS_TABLE_NAME',
    writers: { LeadHandler: 'dynamodb:PutItem' },
  },
  {
    records: 'requests',
    table: 'leads-test-request-ledger',
    key: 'requestID',
    variable: 'REQUEST_LEDGER_TABLE_NAME',
    // Only the inbox handler puts a new entry. Every handler updates the progress of an entry.
    writers: {
      InboxHandler: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      LeadSourcesHandler: 'dynamodb:UpdateItem',
      LeadHandler: 'dynamodb:UpdateItem',
    },
  },
])(
  'stores $records in an on-demand table keyed by $key, that only its writers can write to',
  ({ table, key, variable, writers }) => {
    const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
    const [tableId] = Object.keys(template.findResources('AWS::DynamoDB::Table', { Properties: { TableName: table } }));
    const tableArn = { 'Fn::GetAtt': [tableId, 'Arn'] };

    template.hasResource('AWS::DynamoDB::Table', {
      Properties: {
        TableName: table,
        KeySchema: [{ AttributeName: key, KeyType: 'HASH' }],
        AttributeDefinitions: [{ AttributeName: key, AttributeType: 'S' }],
        BillingMode: 'PAY_PER_REQUEST',
      },
      DeletionPolicy: 'Retain',
    });
    const handlers = Object.values(
      template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'index.handler', Runtime: 'nodejs24.x' },
      })
    );
    expect(handlers).toHaveLength(3);
    // Each handler builds the same services, so each one names the table.
    for (const handler of handlers) {
      expect(handler.Properties.Environment.Variables).toMatchObject({ [variable]: { Ref: tableId } });
    }
    const grants = Object.values(
      template.findResources('AWS::IAM::Policy', {
        Properties: {
          PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Resource: Match.arrayWith([tableArn]) })]) },
        },
      })
    );
    const writes = grants.map((grant) => ({
      role: grant.Properties.Roles[0].Ref,
      actions: grant.Properties.PolicyDocument.Statement.find(
        (statement: { Resource: unknown }) => JSON.stringify(statement.Resource) === JSON.stringify([tableArn])
      ).Action,
    }));
    expect(writes).toHaveLength(Object.keys(writers).length);
    for (const [writer, actions] of Object.entries(writers)) {
      expect(writes).toContainEqual({ role: expect.stringMatching(new RegExp(`^${writer}ServiceRole`)), actions });
    }
  }
);

test('keeps leads in LeadsQueue for the maximum retention of 14 days', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));

  const queues = template.findResources('AWS::SQS::Queue', { Properties: { QueueName: 'leads-test-leads' } });

  expect(Object.values(queues)).toMatchObject([
    { Properties: { MessageRetentionPeriod: 14 * 24 * 60 * 60, RedrivePolicy: { maxReceiveCount: 1 } } },
  ]);
});

test('receives nothing through SES without an inbox address', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));

  for (const type of ['AWS::SES::EmailIdentity', 'AWS::SES::ReceiptRuleSet', 'AWS::SES::ReceiptRule', 'Custom::AWS']) {
    expect(template.findResources(type)).toEqual({});
  }
});

test('receives the inbox address through its rule in the shared rule set leads-mail', () => {
  const template = Template.fromStack(
    new LeadsStack(new App(), 'TestLeads', { ...props, inboxAddress: 'noreply@cdk.ses.example.com' })
  );
  const [bucketId] = Object.keys(
    template.findResources('AWS::S3::Bucket', { Properties: { BucketName: 'leads-test-inbox' } })
  );

  template.resourceCountIs('AWS::SES::EmailIdentity', 1);
  // The ID of the live identity: a new ID replaces the verified identity.
  expect(Object.keys(template.findResources('AWS::SES::EmailIdentity'))[0]).toMatch(/^MailIdentity/);
  template.hasResourceProperties('AWS::SES::EmailIdentity', {
    EmailIdentity: 'cdk.ses.example.com',
    DkimSigningAttributes: Match.absent(),
  });
  // The stack owns only its rule in `leads-mail`. The mail stack of iac/alchemy owns the rule set and its activation.
  expect(template.findResources('AWS::SES::ReceiptRuleSet')).toEqual({});
  expect(template.findResources('Custom::AWS')).toEqual({});
  template.resourceCountIs('AWS::SES::ReceiptRule', 1);
  template.hasResourceProperties('AWS::SES::ReceiptRule', {
    RuleSetName: 'leads-mail',
    Rule: {
      Name: 'leads-test-inbox',
      Enabled: true,
      Recipients: ['noreply@cdk.ses.example.com'],
      ScanEnabled: true,
      Actions: [{ S3Action: { BucketName: { Ref: bucketId } } }],
    },
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    Bucket: { Ref: bucketId },
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: 's3:PutObject', Principal: { Service: 'ses.amazonaws.com' } }),
      ]),
    },
  });
  template.hasOutput('MailMxRecord', {
    Value: {
      'Fn::Join': ['', ['MX cdk.ses.example.com 10 inbound-smtp.', { Ref: 'AWS::Region' }, '.amazonaws.com']],
    },
  });
  expect(Object.keys(template.findOutputs('*')).filter((id) => id.startsWith('MailDkimRecord'))).toHaveLength(3);
  expect(Object.keys(template.findOutputs('*')).filter((id) => id.startsWith('Inbox'))).toEqual([]);
});

test('rejects an inbox address that is not a lowercase email address', () => {
  expect(
    () =>
      new LeadsStack(new App(), 'TestLeads', {
        ...props,
        inboxAddress: 'NoReply@CDK.SES.Example.com',
      })
  ).toThrow('Inbox address must be a lowercase email address');
});

test('makes each bucket refuse a request without TLS and block every public access', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));

  for (const suffix of ['inbox', 'lead-sources']) {
    const [bucketId] = Object.keys(
      template.findResources('AWS::S3::Bucket', {
        Properties: {
          BucketName: `leads-test-${suffix}`,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true,
          },
        },
      })
    );
    expect(bucketId).toBeDefined();
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      Bucket: { Ref: bucketId },
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  }
});

test('gives each handler a log group of the stack with the shared retention', () => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));
  const logGroups = template.findResources('AWS::Logs::LogGroup', {
    Properties: { RetentionInDays: handlerSettings.logRetentionDays },
  });

  expect(Object.keys(logGroups)).toHaveLength(3);
  for (const handlerId of ['InboxHandler', 'LeadSourcesHandler', 'LeadHandler']) {
    template.hasResourceProperties('AWS::Lambda::Function', {
      LoggingConfig: { LogGroup: { Ref: Match.stringLikeRegexp(`^${handlerId}Logs`) } },
    });
  }
});

test.each([
  ['inbox', 'InboxDeadLetterQueue'],
  ['lead-sources', 'LeadSourcesDeadLetterQueue'],
  ['leads', 'LeadsDeadLetterQueue'],
])('raises an alarm when the %s DLQ holds a message', (suffix, queueId) => {
  const template = Template.fromStack(new LeadsStack(new App(), 'TestLeads', props));

  template.hasResourceProperties('AWS::CloudWatch::Alarm', {
    AlarmName: `leads-test-${suffix}-dlq-not-empty`,
    Namespace: 'AWS/SQS',
    MetricName: 'ApproximateNumberOfMessagesVisible',
    Dimensions: [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [Match.stringLikeRegexp(`^${queueId}`), 'QueueName'] } }],
    Threshold: 1,
    ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    TreatMissingData: 'notBreaching',
  });
});

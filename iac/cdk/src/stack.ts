import { lambdaBundle } from '@leads/lambda/bundle';
import { decodeRuntimeSettings, runtimeSettingsJsonSchema } from '@leads/pipeline/settings';
import { handlerSettings, handlerTimeoutOf } from '@leads/shared/domain/handlerSettings';
import { queueSettings, visibilityTimeout } from '@leads/shared/domain/queueSettings';
import type { StageName } from '@leads/shared/domain/stages';
import { mailNames, resourceNames } from '@leads/shared/names';
import { Aws, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as appconfig from 'aws-cdk-lib/aws-appconfig';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as ses from 'aws-cdk-lib/aws-ses';
import * as sesActions from 'aws-cdk-lib/aws-ses-actions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export interface LeadsStackProps extends StackProps {
  readonly bucketPrefix: string;
  readonly lambdaEndpoint?: string;
  /** The folder of the Lambda bundles. The default is the bundle of a real deployment. */
  readonly lambdaAssetDirectory?: string;
  /**
   * The address that SES receives into the inbox bucket, such as `noreply@cdk.ses.example.com`, through the rule of
   * the stack in the shared rule set `leads-mail`. Without it, SES receives nothing.
   */
  readonly inboxAddress?: string;
  /** The whitelist in the seed document of the runtime settings. */
  readonly senderWhitelist: readonly string[];
}

/** The event source mapping of a stage, from the shared queue settings. A window of 0 is the AWS default, so the template leaves it out. */
const mappingOf = (stage: StageName) => {
  const { batchSize, batchingWindow, maxConcurrency } = queueSettings.mapping[stage];
  return {
    batchSize,
    maxConcurrency,
    ...(batchingWindow > 0 && { maxBatchingWindow: Duration.millis(batchingWindow) }),
  };
};

/** The visibility timeout of the queue of a stage, from the shared visibility rule. */
const queueVisibilityOf = (stage: StageName) =>
  Duration.millis(visibilityTimeout(handlerTimeoutOf[stage], queueSettings.mapping[stage].batchingWindow));

export class LeadsStack extends Stack {
  readonly buckets: Record<string, s3.Bucket>;

  constructor(scope: Construct, id: string, props: LeadsStackProps) {
    super(scope, id, props);

    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(props.bucketPrefix) || props.bucketPrefix.length > 37) {
      throw new Error('Bucket prefix must be 2-37 lowercase letters, digits, or hyphens');
    }

    const names = resourceNames(props.bucketPrefix);
    // Each request must use TLS, and no policy or ACL can make an object public.
    const bucket = (id: string, stage: 'inbox' | 'leadSources') =>
      new s3.Bucket(this, id, {
        bucketName: names.bucket(stage),
        enforceSSL: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      });

    // A handler deletes each file that it processed or rejected, so the ledger is the only record of a handled request.
    const inbox = bucket('Inbox', 'inbox');
    const leadSources = bucket('LeadSources', 'leadSources');

    this.buckets = { inbox, leadSources };

    inbox.addToResourcePolicy(
      new PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [inbox.arnForObjects('*')],
        principals: [new ServicePrincipal('ses.amazonaws.com')],
        conditions: { StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID } },
      })
    );

    // The key is the idempotency key of the lead, so the order repository stores each lead only once.
    const orders = new dynamodb.Table(this, 'Orders', {
      tableName: names.ordersTable,
      partitionKey: { name: 'idempotencyKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    // The key is the SES message ID of the email, so the request ledger has one entry for each email.
    // TTL deletes an entry one week after its last change, so the scans of the lab stay small.
    const requestLedger = new dynamodb.Table(this, 'RequestLedger', {
      tableName: names.requestLedgerTable,
      partitionKey: { name: 'requestID', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
    });

    const runtimeSettings = this.runtimeSettings(props);
    const localEndpoint = props.lambdaEndpoint === undefined ? {} : { FLOCI_ENDPOINT: props.lambdaEndpoint };
    const commonEnvironment = {
      LEAD_SOURCES_BUCKET_NAME: names.bucket('leadSources'),
      ORDERS_TABLE_NAME: orders.tableName,
      REQUEST_LEDGER_TABLE_NAME: requestLedger.tableName,
      APPCONFIG_APPLICATION_ID: runtimeSettings.applicationId,
      APPCONFIG_ENVIRONMENT_ID: runtimeSettings.environmentId,
      APPCONFIG_PROFILE_ID: runtimeSettings.configurationProfileId,
      ...localEndpoint,
    };

    // The bundle of a stage is in the folder of the stage name. Each handler logs to a log group of the stack, with a
    // retention, and not to the group that Lambda makes on the first invocation, which keeps each log forever.
    const handler = (id: string, stage: StageName, memorySize?: number) =>
      new lambda.Function(this, id, {
        logGroup: new logs.LogGroup(this, `${id}Logs`, {
          retention: handlerSettings.logRetentionDays as logs.RetentionDays,
        }),
        runtime: lambda.Runtime.NODEJS_24_X,
        code: lambda.Code.fromAsset(`${props.lambdaAssetDirectory ?? lambdaBundle.live}/${stage}`),
        handler: 'index.handler',
        timeout: Duration.millis(handlerTimeoutOf[stage]),
        ...(memorySize === undefined ? {} : { memorySize }),
        environment: commonEnvironment,
        reservedConcurrentExecutions: handlerSettings.stageCaps[stage],
      });

    const inboxHandler = handler('InboxHandler', 'inbox');
    const leadSourcesHandler = handler('LeadSourcesHandler', 'leadSources', handlerSettings.memorySize.leadSources);
    // A batch holds at most ten leads, and the handler only stores them, so one minute is enough.
    const leadHandler = handler('LeadHandler', 'leads', handlerSettings.memorySize.leads);

    const deadLetterRetention = Duration.millis(queueSettings.deadLetterRetention);
    const { maxReceiveCount } = queueSettings;
    const inboxDeadLetterQueue = new sqs.Queue(this, 'InboxDeadLetterQueue', {
      queueName: names.dlq('inbox'),
      retentionPeriod: deadLetterRetention,
    });
    const inboxQueue = new sqs.Queue(this, 'InboxQueue', {
      queueName: names.queue('inbox'),
      visibilityTimeout: queueVisibilityOf('inbox'),
      deadLetterQueue: { queue: inboxDeadLetterQueue, maxReceiveCount },
    });
    inboxHandler.addEventSource(new SqsEventSource(inboxQueue, mappingOf('inbox')));

    const leadSourcesDeadLetterQueue = new sqs.Queue(this, 'LeadSourcesDeadLetterQueue', {
      queueName: names.dlq('leadSources'),
      retentionPeriod: deadLetterRetention,
    });
    const leadSourcesQueue = new sqs.Queue(this, 'LeadSourcesQueue', {
      queueName: names.queue('leadSources'),
      visibilityTimeout: queueVisibilityOf('leadSources'),
      deadLetterQueue: { queue: leadSourcesDeadLetterQueue, maxReceiveCount },
    });
    leadSourcesHandler.addEventSource(new SqsEventSource(leadSourcesQueue, mappingOf('leadSources')));

    const leadsDeadLetterQueue = new sqs.Queue(this, 'LeadsDeadLetterQueue', {
      queueName: names.dlq('leads'),
      retentionPeriod: deadLetterRetention,
    });
    const leadsQueue = new sqs.Queue(this, 'LeadsQueue', {
      queueName: names.queue('leads'),
      retentionPeriod: Duration.millis(queueSettings.retention.leads),
      visibilityTimeout: queueVisibilityOf('leads'),
      deadLetterQueue: { queue: leadsDeadLetterQueue, maxReceiveCount },
    });
    leadHandler.addEventSource(
      new SqsEventSource(leadsQueue, { ...mappingOf('leads'), reportBatchItemFailures: true })
    );
    // No consumer reads a dead-letter queue, so an alarm shows each message that reaches one.
    for (const [stage, deadLetterQueue] of [
      ['inbox', inboxDeadLetterQueue],
      ['leadSources', leadSourcesDeadLetterQueue],
      ['leads', leadsDeadLetterQueue],
    ] as const) {
      new cloudwatch.Alarm(this, `${deadLetterQueue.node.id}Alarm`, {
        alarmName: names.dlqAlarm(stage),
        alarmDescription: `A message is in ${names.dlq(stage)}. Read it in the lab, then redrive it or delete it.`,
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }

    leadsQueue.grantSendMessages(leadSourcesHandler);
    leadSourcesHandler.addEnvironment('LEADS_QUEUE_URL', leadsQueue.queueUrl);

    for (const handler of [inboxHandler, leadSourcesHandler, leadHandler]) {
      runtimeSettings.environment.grantReadConfig(handler);
    }

    this.allow(inboxHandler, 'read', names.bucket('inbox'));
    this.allow(inboxHandler, 'delete', names.bucket('inbox'));
    this.allow(inboxHandler, 'write', names.bucket('leadSources'));

    this.allow(leadSourcesHandler, 'read', names.bucket('leadSources'));
    this.allow(leadSourcesHandler, 'delete', names.bucket('leadSources'));

    orders.grant(leadHandler, 'dynamodb:PutItem');
    // Only the inbox handler puts a new entry. Every handler updates the progress of an entry.
    requestLedger.grant(inboxHandler, 'dynamodb:PutItem', 'dynamodb:UpdateItem');
    requestLedger.grant(leadSourcesHandler, 'dynamodb:UpdateItem');
    requestLedger.grant(leadHandler, 'dynamodb:UpdateItem');

    inbox.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(inboxQueue));
    leadSources.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(leadSourcesQueue));

    if (props.inboxAddress !== undefined) this.receive(props.inboxAddress, names.mailRule, inbox);
  }

  /**
   * Makes the AppConfig profile of the runtime settings and deploys the seed document to it at once.
   * AppConfig keeps each later deployment. A stack update deploys the seed again only when the seed changes.
   */
  private runtimeSettings(props: LeadsStackProps) {
    const names = resourceNames(props.bucketPrefix);
    const seed = decodeRuntimeSettings({
      INBOX_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.inbox,
      LEAD_SOURCES_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leadSources,
      LEAD_INTERNAL_CONCURRENCY: handlerSettings.internalConcurrency.leads,
      INBOX_SENDER_WHITELIST: props.senderWhitelist,
    });
    const application = new appconfig.Application(this, 'RuntimeSettingsApplication', {
      applicationName: names.appConfigApplication,
    });
    const environment = new appconfig.Environment(this, 'RuntimeSettingsEnvironment', {
      application,
      environmentName: 'live',
    });
    const configuration = new appconfig.HostedConfiguration(this, 'RuntimeSettings', {
      application,
      name: 'runtime-settings',
      type: appconfig.ConfigurationType.FREEFORM,
      content: appconfig.ConfigurationContent.fromInlineJson(JSON.stringify(seed)),
      validators: [appconfig.JsonSchemaValidator.fromInline(JSON.stringify(runtimeSettingsJsonSchema()))],
      // No alarm watches a rollout, so a slow rollout or a bake time only delays the change.
      deploymentStrategy: new appconfig.DeploymentStrategy(this, 'RuntimeSettingsRollout', {
        deploymentStrategyName: names.appConfigDeploymentStrategy,
        rolloutStrategy: appconfig.RolloutStrategy.linear({
          growthFactor: 100,
          deploymentDuration: Duration.minutes(0),
          finalBakeTime: Duration.minutes(0),
        }),
      }),
      deployTo: [environment],
    });
    return {
      environment,
      applicationId: application.applicationId,
      environmentId: environment.environmentId,
      configurationProfileId: configuration.configurationProfileId,
    };
  }

  /**
   * Verifies the domain of the address with Easy DKIM, and adds the rule of the stack to the shared rule set
   * `leads-mail`. The rule stores each email to the address in the inbox bucket. The mail stack of iac/alchemy owns
   * `leads-mail` and its activation, so the rule set must exist before this stack adds its rule.
   * The DNS of the domain is not in Route 53, so the stack outputs the DKIM and MX records to add by hand.
   */
  private receive(address: string, ruleName: string, inbox: s3.Bucket): void {
    const domain = address.split('@').at(-1);
    if (domain === undefined || !/^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(address)) {
      throw new Error(`Inbox address must be a lowercase email address: ${address}`);
    }

    // The IDs keep the `Mail` names of the live resources, so CloudFormation does not replace the verified identity.
    const identity = new ses.EmailIdentity(this, 'MailIdentity', { identity: ses.Identity.domain(domain) });
    identity.dkimRecords.forEach((record, index) => {
      new CfnOutput(this, `MailDkimRecord${index + 1}`, { value: `CNAME ${record.name} ${record.value}` });
    });
    new CfnOutput(this, 'MailMxRecord', { value: `MX ${domain} 10 inbound-smtp.${Aws.REGION}.amazonaws.com` });

    new ses.ReceiptRule(this, 'MailRule', {
      ruleSet: ses.ReceiptRuleSet.fromReceiptRuleSetName(this, 'MailRuleSet', mailNames.ruleSet),
      receiptRuleName: ruleName,
      recipients: [address],
      scanEnabled: true,
      // `Bucket` does not match `IBucket` under `exactOptionalPropertyTypes`, but it implements it.
      actions: [new sesActions.S3({ bucket: inbox as s3.IBucket })],
    });
  }

  private allow(handler: lambda.Function, action: 'read' | 'write' | 'delete', bucketName: string): void {
    const actions = {
      read: ['s3:GetObject', 's3:ListBucket'],
      write: ['s3:PutObject'],
      delete: ['s3:DeleteObject'],
    }[action];
    handler.addToRolePolicy(
      new PolicyStatement({
        actions,
        resources: [`arn:${Aws.PARTITION}:s3:::${bucketName}`, `arn:${Aws.PARTITION}:s3:::${bucketName}/*`],
      })
    );
  }
}

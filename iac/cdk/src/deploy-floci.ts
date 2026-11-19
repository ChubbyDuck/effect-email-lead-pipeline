import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import {
  GetFunctionConcurrencyCommand,
  GetFunctionConfigurationCommand,
  LambdaClient,
  ListEventSourceMappingsCommand,
  UpdateEventSourceMappingCommand,
} from '@aws-sdk/client-lambda';
import {
  CreateBucketCommand,
  GetBucketNotificationConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { deploymentFor, flociEndpointOf } from '@leads/shared/deployments';
import { handlerSettings, handlerTimeoutOf } from '@leads/shared/domain/handlerSettings';
import { queueSettings, visibilityTimeout } from '@leads/shared/domain/queueSettings';
import { resourceNames } from '@leads/shared/names';

process.env.FLOCI_LAMBDA_ENDPOINT ??= 'http://localhost.floci.io:4566';
// The app deploys production without a deployment. This script deploys only to Floci.
process.env.DEPLOYMENT ??= 'local-cdk';
const { app, bucketPrefix, stackId } = await import(process.env.LEADS_CDK_APP ?? './app');
const names = resourceNames(bucketPrefix);
/** The stage of the naming contract for each stage slug. */
const stageNameOf = { inbox: 'inbox', 'lead-sources': 'leadSources', leads: 'leads' } as const;
/** AWS gives a queue attribute and a mapping setting in seconds. The shared settings are in ms. */
const seconds = (ms: number) => ms / 1000;
const leadsBatchingWindow = seconds(queueSettings.mapping.leads.batchingWindow);

/** The Floci of the deployment. `FLOCI_ENDPOINT`, when it is set, wins over the Floci port of the deployment. */
const endpoint = flociEndpointOf(deploymentFor(process.env.DEPLOYMENT, 'cdk'), process.env.FLOCI_ENDPOINT);
if (endpoint === undefined) throw new Error(`The deployment ${process.env.DEPLOYMENT} does not run in Floci`);
const region = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const s3 = new S3Client({ endpoint, region, credentials, forcePathStyle: true });
const cloudformation = new CloudFormationClient({ endpoint, region, credentials });
const lambda = new LambdaClient({ endpoint, region, credentials });
const sqs = new SQSClient({ endpoint, region, credentials, useQueueUrlAsEndpoint: false });
const assembly = app.synth();
const stack = assembly.getStackArtifact(stackId);
const stackName = stack.stackName;
const assets = JSON.parse(await readFile(path.join(assembly.directory, `${stackId}.assets.json`), 'utf8')) as {
  files: Record<
    string,
    {
      source: { path: string; packaging: string };
      destinations: Record<string, { bucketName: string; objectKey: string }>;
    }
  >;
};

async function publishAssets(): Promise<void> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'leads-cdk-assets-'));
  try {
    for (const [hash, asset] of Object.entries(assets.files)) {
      if (asset.source.packaging !== 'zip') continue;
      const destination = Object.values(asset.destinations)[0];
      if (!destination) throw new Error(`No asset destination for ${hash}`);
      const archive = path.join(temporary, `${hash}.zip`);
      const source = path.join(assembly.directory, asset.source.path);
      const zipped = spawnSync('zip', ['-q', '-r', archive, '.'], { cwd: source, encoding: 'utf8' });
      if (zipped.status !== 0) throw new Error(`Could not zip ${source}: ${zipped.stderr}`);
      try {
        await s3.send(new CreateBucketCommand({ Bucket: destination.bucketName }));
      } catch (error) {
        if (!(error instanceof Error) || !['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)) {
          throw error;
        }
      }
      await s3.send(
        new PutObjectCommand({
          Bucket: destination.bucketName,
          Key: destination.objectKey,
          Body: await readFile(archive),
        })
      );
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function stackExists(): Promise<boolean> {
  try {
    await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ValidationError') return false;
    throw error;
  }
}

async function waitForStack(): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt++) {
    const result = await cloudformation.send(new DescribeStacksCommand({ StackName: stackName }));
    const status = result.Stacks?.[0]?.StackStatus;
    if (status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE') return;
    if (status?.includes('FAILED') || status?.includes('ROLLBACK')) {
      throw new Error(`${stackName}: ${status}: ${result.Stacks?.[0]?.StackStatusReason ?? ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${stackName}`);
}

async function reconcileFlociBatchingWindow(): Promise<void> {
  const { EventSourceMappings } = await lambda.send(new ListEventSourceMappingsCommand({}));
  const mapping = EventSourceMappings?.find((item) => item.EventSourceArn?.endsWith(`:${names.queue('leads')}`));
  if (!mapping?.UUID) throw new Error('Missing LeadsQueue event source mapping');
  if (mapping.MaximumBatchingWindowInSeconds !== leadsBatchingWindow) {
    // Floci 2.1.0's CloudFormation provisioner does not forward this property.
    // Apply the synthesized value through its supported Lambda API, then verify it normally.
    await lambda.send(
      new UpdateEventSourceMappingCommand({
        UUID: mapping.UUID,
        MaximumBatchingWindowInSeconds: leadsBatchingWindow,
      })
    );
    console.log('Applied the CDK LeadsQueue batching window through the Floci Lambda API.');
  }
}

async function reconcileFlociDlqRetention(): Promise<void> {
  // Floci 2.1.0 also omits MessageRetentionPeriod in its CloudFormation SQS provisioner.
  const template = JSON.parse(await readFile(path.join(assembly.directory, stack.templateFile), 'utf8')) as {
    Resources: Record<string, { Type: string; Properties?: { QueueName?: string; MessageRetentionPeriod?: number } }>;
  };
  for (const resource of Object.values(template.Resources)) {
    const properties = resource.Properties;
    if (resource.Type !== 'AWS::SQS::Queue' || !properties?.MessageRetentionPeriod || !properties.QueueName) continue;
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: properties.QueueName }));
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: QueueUrl!, AttributeNames: ['MessageRetentionPeriod'] })
    );
    const retention = String(properties.MessageRetentionPeriod);
    if (Attributes?.MessageRetentionPeriod === retention) continue;
    await sqs.send(
      new SetQueueAttributesCommand({ QueueUrl: QueueUrl!, Attributes: { MessageRetentionPeriod: retention } })
    );
    console.log(`Applied the CDK retention for ${properties.QueueName} through the Floci SQS API.`);
  }
}

async function verifyStack(): Promise<void> {
  const resources = await cloudformation.send(new DescribeStackResourcesCommand({ StackName: stackName }));
  const incomplete = resources.StackResources?.filter(
    (resource) =>
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(resource.ResourceStatus ?? '') ||
      resource.ResourceStatusReason?.includes('not supported by Floci')
  );
  if (incomplete?.length) {
    throw new Error(
      `Incomplete Floci resources: ${incomplete.map((resource) => resource.LogicalResourceId).join(', ')}`
    );
  }
  const count = (type: string) =>
    resources.StackResources?.filter((resource) => resource.ResourceType === type).length ?? 0;
  // The E2E app adds its own bucket to the stack, so the template gives the number of buckets.
  const template = JSON.parse(await readFile(path.join(assembly.directory, stack.templateFile), 'utf8')) as {
    Resources: Record<string, { Type: string }>;
  };
  const buckets = Object.values(template.Resources).filter((resource) => resource.Type === 'AWS::S3::Bucket').length;
  for (const [type, expected] of [
    ['AWS::S3::Bucket', buckets],
    ['AWS::Lambda::Function', 4],
    ['AWS::Lambda::Permission', 0],
    ['AWS::IAM::Role', 4],
    ['Custom::S3BucketNotifications', 2],
    ['AWS::SQS::Queue', 6],
    ['AWS::SQS::QueuePolicy', 2],
    ['AWS::Lambda::EventSourceMapping', 3],
    ['AWS::DynamoDB::Table', 2],
    ['AWS::Logs::LogGroup', 3],
    ['AWS::CloudWatch::Alarm', 3],
  ] as const) {
    if (count(type) !== expected) throw new Error(`Expected ${expected} ${type} resources; found ${count(type)}`);
  }
  for (const type of ['AWS::EC2::VPC', 'AWS::Logs::SubscriptionFilter']) {
    if (count(type) !== 0) throw new Error(`Unexpected ${type} resource`);
  }
  for (const [stage, handlerId] of [
    ['inbox', 'InboxHandler'],
    ['lead-sources', 'LeadSourcesHandler'],
    ['leads', 'LeadHandler'],
  ] as const) {
    const handler = resources.StackResources?.find(
      (resource) =>
        resource.ResourceType === 'AWS::Lambda::Function' && resource.LogicalResourceId?.startsWith(handlerId)
    );
    if (!handler?.PhysicalResourceId) throw new Error(`Missing ${handlerId}`);
    const configuration = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: handler.PhysicalResourceId })
    );
    if (configuration.Runtime !== 'nodejs24.x') throw new Error(`Unexpected runtime for ${handlerId}`);
    if (configuration.Environment?.Variables?.FLOCI_ENDPOINT !== process.env.FLOCI_LAMBDA_ENDPOINT) {
      throw new Error(`Unexpected Floci endpoint for ${handlerId}`);
    }
    const queueConfig = queueSettings.mapping[stageNameOf[stage]];
    const expectedVisibility = String(
      seconds(visibilityTimeout(handlerTimeoutOf[stageNameOf[stage]], queueConfig.batchingWindow))
    );
    const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: names.queue(stageNameOf[stage]) }));
    if (!QueueUrl) throw new Error(`Missing ${stage} queue`);
    const { Attributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn', 'VisibilityTimeout', 'RedrivePolicy'] })
    );
    const queueArn = Attributes?.QueueArn;
    if (!queueArn || Attributes?.VisibilityTimeout !== expectedVisibility) {
      throw new Error(`Unexpected ${stage} queue configuration`);
    }
    const redrive = JSON.parse(Attributes?.RedrivePolicy ?? '{}') as {
      maxReceiveCount?: number | string;
      deadLetterTargetArn?: string;
    };
    if (
      Number(redrive.maxReceiveCount) !== queueSettings.maxReceiveCount ||
      !redrive.deadLetterTargetArn?.endsWith(names.dlq(stageNameOf[stage]))
    ) {
      throw new Error(`Missing ${stage} dead-letter policy`);
    }
    const dlqMappings = await lambda.send(
      new ListEventSourceMappingsCommand({
        EventSourceArn: redrive.deadLetterTargetArn,
      })
    );
    if (dlqMappings.EventSourceMappings?.some((mapping) => mapping.EventSourceArn === redrive.deadLetterTargetArn))
      throw new Error(`${stage} DLQ must have no consumer`);
    const { QueueUrl: dlqUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: names.dlq(stageNameOf[stage]) }));
    const { Attributes: dlqAttributes } = await sqs.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl!, AttributeNames: ['MessageRetentionPeriod'] })
    );
    if (dlqAttributes?.MessageRetentionPeriod !== String(seconds(queueSettings.deadLetterRetention)))
      throw new Error(`${stage} DLQ must retain messages for fourteen days`);
    // The leads stage has no bucket: the sources handler sends each lead straight to its queue.
    if (stage !== 'leads') {
      const notification = await s3.send(
        new GetBucketNotificationConfigurationCommand({ Bucket: names.bucket(stageNameOf[stage]) })
      );
      if (
        notification.QueueConfigurations?.length !== 1 ||
        notification.QueueConfigurations[0]?.QueueArn !== queueArn ||
        notification.LambdaFunctionConfigurations?.length
      ) {
        throw new Error(`Missing S3 notification from ${stage} to SQS`);
      }
    }
    const concurrency = await lambda.send(
      new GetFunctionConcurrencyCommand({ FunctionName: handler.PhysicalResourceId })
    );
    if (concurrency.ReservedConcurrentExecutions !== handlerSettings.stageCaps[stageNameOf[stage]]) {
      throw new Error(`Unexpected ${stage} reserved concurrency`);
    }
    const mappings = await lambda.send(
      new ListEventSourceMappingsCommand({ FunctionName: handler.PhysicalResourceId, EventSourceArn: queueArn })
    );
    const mapping = mappings.EventSourceMappings?.[0];
    if (
      mappings.EventSourceMappings?.length !== 1 ||
      mapping?.BatchSize !== queueConfig.batchSize ||
      (stage === 'leads' &&
        (mapping.MaximumBatchingWindowInSeconds !== leadsBatchingWindow ||
          !mapping.FunctionResponseTypes?.includes('ReportBatchItemFailures'))) ||
      mapping.State !== 'Enabled'
    ) {
      throw new Error(`Unexpected ${stage} SQS event source mapping`);
    }
    if (mapping.ScalingConfig?.MaximumConcurrency === undefined) {
      console.warn(
        'Floci does not expose SQS MaximumConcurrency. The CDK template sets it; the function concurrency ceiling is verified above.'
      );
    } else if (mapping.ScalingConfig.MaximumConcurrency !== queueConfig.maxConcurrency) {
      throw new Error(`Unexpected ${stage} SQS maximum concurrency`);
    }
  }

  const { QueueUrl: leadsQueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: names.queue('leads') }));
  if (!leadsQueueUrl) throw new Error('Missing LeadsQueue');
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: leadsQueueUrl, AttributeNames: ['QueueArn'] })
  );
  if (!Attributes?.QueueArn) throw new Error('Missing LeadsQueue ARN');
  const producer = resources.StackResources?.find(
    (resource) =>
      resource.ResourceType === 'AWS::Lambda::Function' && resource.LogicalResourceId?.startsWith('LeadSourcesHandler')
  );
  if (!producer?.PhysicalResourceId) throw new Error('Missing LeadSourcesHandler');
  const configuration = await lambda.send(
    new GetFunctionConfigurationCommand({ FunctionName: producer.PhysicalResourceId })
  );
  if (configuration.Environment?.Variables?.LEADS_QUEUE_URL !== leadsQueueUrl) {
    throw new Error('LeadSourcesHandler is not configured to publish to LeadsQueue');
  }
}

try {
  await publishAssets();
  const template = JSON.parse(await readFile(path.join(assembly.directory, stack.templateFile), 'utf8')) as {
    Parameters?: Record<string, unknown>;
    Rules?: Record<string, unknown>;
  };
  if (template.Parameters) {
    delete template.Parameters.BootstrapVersion;
    if (Object.keys(template.Parameters).length === 0) delete template.Parameters;
  }
  if (template.Rules) {
    delete template.Rules.CheckBootstrapVersion;
    if (Object.keys(template.Rules).length === 0) delete template.Rules;
  }
  const input = {
    StackName: stackName,
    TemplateBody: JSON.stringify(template),
    Capabilities: ['CAPABILITY_IAM' as const],
  };
  if (await stackExists()) {
    try {
      await cloudformation.send(new UpdateStackCommand(input));
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('No updates are to be performed')) throw error;
    }
  } else {
    await cloudformation.send(new CreateStackCommand(input));
  }
  await waitForStack();
  await reconcileFlociBatchingWindow();
  await reconcileFlociDlqRetention();
  await verifyStack();
  console.log(`Deployed and verified ${stackName} in Floci at ${endpoint}`);
} finally {
  s3.destroy();
  cloudformation.destroy();
  lambda.destroy();
  sqs.destroy();
}

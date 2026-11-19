import { lambdaBundle } from '@leads/lambda/bundle';
import { deploymentFor } from '@leads/shared/deployments';
import { resourceNames } from '@leads/shared/names';
import { App } from 'aws-cdk-lib';
import { Function as LambdaFunction } from 'aws-cdk-lib/aws-lambda';
import { Bucket } from 'aws-cdk-lib/aws-s3';

import { LeadsStack } from '../stack';

const deployment = deploymentFor('e2e-cdk', 'cdk');
export const app = new App();
/** One start script can set its own prefix, so that two runs do not share resources. */
export const bucketPrefix = process.env.LEADS_BUCKET_PREFIX ?? deployment.prefix;
export const stackId = resourceNames(bucketPrefix).stack;
const { senderWhitelist } = deployment;
const stack = new LeadsStack(app, stackId, {
  bucketPrefix,
  senderWhitelist,
  lambdaAssetDirectory: lambdaBundle.e2e,
  lambdaEndpoint: process.env.FLOCI_LAMBDA_ENDPOINT ?? 'http://floci:4566',
  env: { account: deployment.account, region: deployment.region },
});
// The harness writes its control file here, and the E2E adapters write what they observe.
const e2e = new Bucket(stack, 'E2E', { bucketName: resourceNames(bucketPrefix).e2eBucket });
for (const child of stack.node.findAll()) {
  if (!(child instanceof LambdaFunction)) continue;
  e2e.grantReadWrite(child);
  child.addEnvironment('E2E_BUCKET_NAME', e2e.bucketName);
  // Floci's CloudFormation does not make AppConfig resources, so the E2E services read the whitelist from the environment.
  child.addEnvironment('INBOX_SENDER_WHITELIST', senderWhitelist.join(','));
}

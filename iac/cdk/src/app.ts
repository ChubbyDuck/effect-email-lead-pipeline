import { defaultDeployment, deploymentFor } from '@leads/shared/deployments';
import { resourceNames } from '@leads/shared/names';
import { App } from 'aws-cdk-lib';

import { LeadsStack } from './stack';

export const app = new App();
/** `--context deployment=<name>` wins over `DEPLOYMENT`. */
const name = app.node.tryGetContext('deployment') ?? process.env.DEPLOYMENT ?? defaultDeployment;
const deployment = deploymentFor(name, 'cdk');
// Only the Floci deployment script sets this. It points the Lambda containers back to the emulator.
const lambdaEndpoint = name === 'local-cdk' ? process.env.FLOCI_LAMBDA_ENDPOINT : undefined;
export const bucketPrefix = deployment.prefix;
export const stackId = resourceNames(bucketPrefix).stack;
new LeadsStack(app, stackId, {
  bucketPrefix,
  senderWhitelist: deployment.senderWhitelist,
  ...(deployment.inboxAddress !== undefined && { inboxAddress: deployment.inboxAddress }),
  ...(lambdaEndpoint && { lambdaEndpoint }),
  env: { account: deployment.account, region: deployment.region },
});

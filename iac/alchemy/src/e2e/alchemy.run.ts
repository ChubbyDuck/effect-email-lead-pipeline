import * as AWS from '@alchemy.run/aws';
import { lambdaBundle } from '@leads/lambda/bundle';
import { deploymentFor } from '@leads/shared/deployments';
import { alchemyPipeline, resourceNames } from '@leads/shared/names';
import * as Alchemy from 'alchemy';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

import { leadsPipeline } from '#stack';
import { targetOf } from '#target';

/**
 * The e2e app of Alchemy: the stage `e2e-alchemy` of the pipeline, with the same additions as the CDK e2e app
 * (iac/cdk/src/e2e/app.ts). The e2e suite deploys it with `alchemy deploy src/e2e/alchemy.run.ts --stage e2e-alchemy`.
 */
const name = 'e2e-alchemy';
const deployment = deploymentFor(name, 'alchemy');
/** One start script can set its own prefix, so that two runs do not share resources. */
const prefix = process.env.LEADS_BUCKET_PREFIX ?? deployment.prefix;
const target = { ...deployment, prefix };
const names = resourceNames(prefix);
const e2eBucketArn = `arn:aws:s3:::${names.e2eBucket}`;
// FLOCI_ENDPOINT, when it is set, wins over the Floci port of the deployment.
const { providers } = targetOf(name, target, process.env.FLOCI_ENDPOINT);

/** Thrown when the e2e app is deployed to a stage that is not `e2e-alchemy`. */
export class NotTheE2EStage extends Data.TaggedError('NotTheE2EStage')<{ readonly stage: string }> {
  override get message(): string {
    return `The e2e app deploys only the stage ${alchemyPipeline.stage(name)}, not ${this.stage}`;
  }
}

export default Alchemy.Stack(
  alchemyPipeline.stack,
  {
    providers,
    // Each run of the e2e suite starts a new Floci, so the state of a run must not outlive it.
    state: Alchemy.inMemoryState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (stage !== alchemyPipeline.stage(name)) return yield* Effect.die(new NotTheE2EStage({ stage }));
    // The harness writes its control file here, and the E2E adapters write what they observe.
    const e2e = yield* AWS.S3.Bucket('E2E', { bucketName: names.e2eBucket });
    const { handlers } = yield* leadsPipeline(target, {
      lambdaEndpoint: process.env.FLOCI_LAMBDA_ENDPOINT ?? 'http://floci:4566',
      lambdaAssetDirectory: lambdaBundle.e2e,
      handlerEnvironment: {
        E2E_BUCKET_NAME: e2e.bucketName,
        // The E2E services read every setting from the environment, not from AppConfig.
        INBOX_SENDER_WHITELIST: target.senderWhitelist.join(','),
      },
    });
    for (const fn of handlers) {
      yield* fn.bind('ReadWriteE2EBucket', {
        policyStatements: [
          {
            Sid: 'ReadWriteE2EBucket',
            Effect: 'Allow',
            Action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject', 's3:DeleteObject'],
            Resource: [e2eBucketArn, `${e2eBucketArn}/*`],
          },
        ],
      });
    }
  })
);

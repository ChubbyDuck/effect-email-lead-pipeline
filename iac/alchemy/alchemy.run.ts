import { deploymentFor, isOnFloci } from '@leads/shared/deployments';
import { alchemyPipeline } from '@leads/shared/names';
import * as Alchemy from 'alchemy';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';

import { leadsPipeline } from '#stack';
import { targetOf } from '#target';

/**
 * The Alchemy stack of the pipeline. Each Alchemy deployment is one stage of it, and the stage is the deployment name
 * (`alchemyPipeline.stage`): `alchemy deploy --stage <deployment>`. A stage that is not an Alchemy deployment fails
 * before anything is planned.
 */
const deployment = Effect.map(Alchemy.Stage, (stage) => ({ name: stage, deployment: deploymentFor(stage, 'alchemy') }));
const target = Effect.map(deployment, ({ name, deployment }) => targetOf(name, deployment, process.env.FLOCI_ENDPOINT));

export default Alchemy.Stack(
  alchemyPipeline.stack,
  {
    providers: Layer.unwrap(Effect.map(target, ({ providers }) => providers)),
    state: Layer.unwrap(Effect.map(target, ({ state }) => state)),
  },
  Effect.flatMap(deployment, ({ deployment }) => {
    // Only a deploy into Floci sets this. It points the handlers back to the emulator: the Compose service `floci`, in
    // the Docker network of the Compose project of that Floci (compose.local-alchemy.yaml).
    const lambdaEndpoint = isOnFloci(deployment)
      ? (process.env.FLOCI_LAMBDA_ENDPOINT ?? 'http://floci:4566')
      : undefined;
    // `alchemy deploy` prints the outputs: the DNS records of the inbox domain, to add by hand.
    return Effect.map(leadsPipeline(deployment, lambdaEndpoint === undefined ? {} : { lambdaEndpoint }), ({ mail }) =>
      mail === undefined ? {} : { mailDkimRecords: mail.dkimRecords, mailMxRecord: mail.mxRecord }
    );
  })
);

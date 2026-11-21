import * as AWS from '@alchemy.run/aws';
import { flociEndpointOf, isOnFloci, type Deployment } from '@leads/shared/deployments';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Redacted from 'effect/Redacted';

/**
 * The AWS environment of a Floci deployment, pinned to the Floci at `endpoint`: the account and the Region of the
 * deployment, and the `test` credentials. `alchemy deploy` ignores `AWS_ENDPOINT_URL`, so the stack gives the providers
 * and the state store this environment (docs/design/alchemy-spike.md, step 9).
 */
export const flociEnvironment = (deployment: Deployment, endpoint: string) =>
  Layer.succeed(
    AWS.AWSEnvironment,
    Effect.succeed({
      accountId: deployment.account,
      region: deployment.region,
      endpoint,
      credentials: Effect.succeed({
        accessKeyId: Redacted.make('test'),
        secretAccessKey: Redacted.make('test'),
        sessionToken: undefined,
        region: deployment.region,
      }),
    })
  );

/** The providers of a Floci deployment, pinned to the Floci at `endpoint`. */
export const flociProviders = (deployment: Deployment, endpoint: string) =>
  AWS.providers().pipe(Layer.provide(flociEnvironment(deployment, endpoint)));

/** Thrown when a Floci deployment has no endpoint to deploy to. */
export class FlociEndpointMissing extends Data.TaggedError('FlociEndpointMissing')<{
  readonly deploymentName: string;
}> {
  override get message(): string {
    return `Give ${this.deploymentName} a flociPort in deployments.ts, or set FLOCI_ENDPOINT to the endpoint of a Floci image of Alchemy`;
  }
}

/**
 * The target of a deployment: its providers and its state. A real deployment takes its credentials from the Alchemy
 * profile (`--profile`) and keeps its state in AWS (`alchemy state bootstrap --backend aws`). A Floci deployment goes to
 * the endpoint of its Floci (`flociEndpointOf`, so `flociEndpoint` wins when it is set), and keeps its state in the
 * DynamoDB of that Floci, as a real deployment keeps it in AWS. Thus the lab reads the state of both in the same way,
 * and the state goes with its Floci.
 */
export const targetOf = (name: string, deployment: Deployment, flociEndpoint: string | undefined) => {
  if (!isOnFloci(deployment)) return { providers: AWS.providers(), state: AWS.state() };
  const endpoint = flociEndpointOf(deployment, flociEndpoint);
  if (endpoint === undefined) throw new FlociEndpointMissing({ deploymentName: name });
  // A Floci has no S3 state store of an older Alchemy to migrate from.
  const state = AWS.state({ migrateFrom: false }).pipe(Layer.provide(flociEnvironment(deployment, endpoint)));
  return { providers: flociProviders(deployment, endpoint), state };
};

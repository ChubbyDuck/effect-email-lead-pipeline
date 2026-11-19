/**
 * The status of an Alchemy deployment, from the Alchemy state in DynamoDB. Only the server imports this file: it brings
 * `@alchemy.run/aws`, and the import protection of the lab keeps a `.server` file out of the client bundle.
 */
import * as AwsCredentials from '@alchemy.run/aws/Credentials';
import * as AwsEndpoint from '@alchemy.run/aws/Endpoint';
import { AWSEnvironment } from '@alchemy.run/aws/Environment';
import * as AwsRegion from '@alchemy.run/aws/Region';
import { makeDynamoDBState } from '@alchemy.run/aws/StateStore';
import { GetFunctionConfigurationCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import type { Deployment } from '@leads/shared/deployments';
import { stageNames } from '@leads/shared/domain/stages';
import { alchemyPipeline, resourceNames } from '@leads/shared/names';
import { ConfigProvider, Effect, Layer, Redacted } from 'effect';
import * as SecureRandom from 'effect/crypto/SecureRandom';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';

import type { DeploymentPhase, DeploymentStatus } from '#Core/Observation/Domain/snapshot';
import { DeploymentStatusNotRead, type DeploymentStatusSource } from '#Core/Observation/Ports/DeploymentStatusSource';

type DynamoDBState = Effect.Success<ReturnType<typeof makeDynamoDBState>>;

/**
 * The reads of the store of `makeDynamoDBState()` that the adapter uses: the catalog status of a stage, and the records
 * of the stage. These reads take no deploy lease. The `get` and `list` of the `StateService` take the lease of the
 * stage and keep it while the store lives, so a read of the lab could make a concurrent `alchemy deploy` fail.
 */
export type AlchemyStateReads = Pick<DynamoDBState['migration'], 'status' | 'readStage'>;

/** The catalog status of a stage: `active`, `rolled-back`, or `destroyed`. No status means that the stage is missing. */
export type CatalogStatus = Effect.Success<ReturnType<AlchemyStateReads['status']>>;

/** The statuses of a resource row while a deploy changes the resource. */
const changing = new Set(['creating', 'updating', 'deleting', 'replacing']);

/** The most resources in progress that the reason names. */
const namedLimit = 5;

/**
 * The phase of a stage. A stage that is missing, destroyed, or rolled back is `failed`. A stage with a resource that a
 * deploy changes now is `in-progress`.
 */
export function alchemyPhase(catalog: CatalogStatus, resourceStatuses: readonly string[]): DeploymentPhase {
  if (catalog === undefined || catalog === 'destroyed' || catalog === 'rolled-back') return 'failed';
  if (resourceStatuses.some((status) => changing.has(status))) return 'in-progress';
  return 'complete';
}

interface ResourceRow {
  readonly fqn: string;
  readonly status: string;
}

/** The status of each resource record. A record of an action has no resource, so it gives nothing. */
function resourceRows(records: ReadonlyMap<string, string>): ResourceRow[] {
  return [...records].flatMap(([fqn, text]) => {
    const record = JSON.parse(text) as { readonly kind?: unknown; readonly status?: unknown };
    return record.kind === 'action' || typeof record.status !== 'string' ? [] : [{ fqn, status: record.status }];
  });
}

function reasonOf(rows: readonly ResourceRow[]) {
  const named = rows.slice(0, namedLimit).map(({ fqn, status }) => `${fqn} is ${status}`);
  const more = rows.length - named.length;
  return more > 0 ? `${named.join(', ')}, and ${more} more` : named.join(', ');
}

export interface AlchemyDeploymentStatusOptions {
  /** The name of the deployment, which is its Alchemy stage. */
  readonly deploymentName: string;
  readonly prefix: string;
  readonly state: AlchemyStateReads;
  readonly lambda: Pick<LambdaClient, 'send'>;
}

/**
 * The status of the Alchemy deployment `deploymentName`: one stage of the Alchemy stack of the pipeline.
 *
 * The Alchemy state keeps no time of the last deploy. The time of the last change is the newest `LastModified` of the
 * three handler functions, so a deploy that changes no function does not move it.
 */
export function makeAlchemyDeploymentStatus({
  deploymentName,
  prefix,
  state,
  lambda,
}: AlchemyDeploymentStatusOptions): DeploymentStatusSource {
  const stack = alchemyPipeline.stack;
  const stage = alchemyPipeline.stage(deploymentName);
  const name = `${stack}/${stage}`;
  const notRead = (error: unknown): never => {
    throw new DeploymentStatusNotRead('alchemy', name, error);
  };

  /** The newest change of a handler function. A missing function gives no time. */
  async function lastChange() {
    const times = await Promise.all(
      stageNames.map((handlerStage) =>
        lambda
          .send(new GetFunctionConfigurationCommand({ FunctionName: resourceNames(prefix).functionName(handlerStage) }))
          .then(({ LastModified }) => (LastModified === undefined ? [] : [Date.parse(LastModified)]))
          .catch((error: unknown) => {
            if (error instanceof Error && error.name === 'ResourceNotFoundException') return [];
            throw error;
          })
      )
    );
    const valid = times.flat().filter((time) => !Number.isNaN(time));
    return valid.length === 0 ? undefined : new Date(Math.max(...valid)).toISOString();
  }

  return {
    async read(): Promise<DeploymentStatus> {
      const [catalog, contents] = await Effect.runPromise(
        Effect.all([state.status(stack, stage), state.readStage(stack, stage)], { concurrency: 2 })
      ).catch(notRead);
      let rows: ResourceRow[];
      try {
        rows = resourceRows(contents.records);
      } catch (error) {
        return notRead(error);
      }
      const phase = alchemyPhase(
        catalog,
        rows.map(({ status }) => status)
      );
      const inProgress = rows.filter(({ status }) => changing.has(status));
      const status =
        catalog === undefined
          ? 'missing'
          : phase === 'in-progress'
            ? [...new Set(inProgress.map((row) => row.status))].toSorted().join(', ')
            : catalog;
      const reason =
        catalog === undefined
          ? `The Alchemy state has no stage ${stage} of ${stack}.`
          : phase === 'in-progress'
            ? reasonOf(inProgress)
            : undefined;
      const updatedAt =
        catalog === undefined || catalog === 'destroyed' ? undefined : await lastChange().catch(notRead);
      return {
        tool: 'alchemy',
        name,
        phase,
        status,
        ...(reason !== undefined && { reason }),
        ...(updatedAt !== undefined && { updatedAt }),
      };
    },
  };
}

/** A source of AWS credentials, such as the `credentials` of the resolved config of an AWS SDK client. */
export type CredentialsSource = () => Promise<{
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
}>;

export interface AlchemyStateOptions {
  readonly deployment: Deployment;
  readonly credentials: CredentialsSource;
  /** The endpoint of an emulator, such as Floci. */
  readonly endpoint?: string;
}

/**
 * The reads of the Alchemy state of `deployment`: the store of `makeDynamoDBState()` in its account and Region, as
 * `alchemy deploy` keeps it (`AWS.state()`). Each read makes a new store, so a store that was missing at one read is
 * found at the next one.
 *
 * The store makes its table and its bucket when they are missing, except in CI. The reads run as CI, so the lab never
 * makes them: a missing store fails the read. The stages are in DynamoDB only, so the store does not look into the old
 * S3 store.
 */
export function alchemyStateOf({ deployment, credentials, endpoint }: AlchemyStateOptions): AlchemyStateReads {
  const environment = Layer.succeed(
    AWSEnvironment,
    Effect.succeed({
      accountId: deployment.account,
      region: deployment.region,
      ...(endpoint !== undefined && { endpoint }),
      credentials: Effect.promise(() => credentials()).pipe(
        Effect.map((identity) => ({
          accessKeyId: Redacted.make(identity.accessKeyId),
          secretAccessKey: Redacted.make(identity.secretAccessKey),
          sessionToken: identity.sessionToken === undefined ? undefined : Redacted.make(identity.sessionToken),
          region: deployment.region,
          ...(identity.expiration !== undefined && { expiration: identity.expiration.getTime() }),
        }))
      ),
    })
  );
  const services = Layer.mergeAll(
    AwsCredentials.fromEnvironment,
    AwsRegion.fromEnvironment,
    AwsEndpoint.fromEnvironment
  ).pipe(
    Layer.provideMerge(environment),
    Layer.merge(FetchHttpClient.layer),
    Layer.merge(SecureRandom.layerWebCrypto),
    Layer.merge(ConfigProvider.layer(ConfigProvider.fromUnknown({ CI: 'true' })))
  );
  const withStore = <A, E>(read: (store: DynamoDBState) => Effect.Effect<A, E>) =>
    Effect.scoped(Effect.flatMap(makeDynamoDBState({ migrateFrom: false }), read)).pipe(Effect.provide(services));
  return {
    status: (stack, stage) => withStore((store) => store.migration.status(stack, stage)),
    readStage: (stack, stage) => withStore((store) => store.migration.readStage(stack, stage)),
  };
}

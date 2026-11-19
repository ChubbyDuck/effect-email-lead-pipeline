/**
 * The services of the lab, wired once for each server process. Only the server functions and the server routes
 * use them.
 *
 * `DEPLOYMENT` selects the deployment (default `production-cdk`). A real deployment reads the AWS credentials of
 * `AWS_PROFILE`. `FLOCI_ENDPOINT` sends every call to an emulator.
 */
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { DynamoDBClient, type ScanCommandInput, type ScanCommandOutput } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defaultDeployment, deploymentNamed } from '@leads/shared/deployments';
import { RequestID } from '@leads/shared/domain/request';
import { makeRequestLedgerLive } from '@leads/shared/infrastructure/RequestLedger/live';
import { resourceNames } from '@leads/shared/names';
import { RequestLedger } from '@leads/shared/ports/RequestLedger';
import { ConfigProvider, Effect, Layer, ManagedRuntime } from 'effect';

import { makeRequestFeed } from '#Core/Observation/Domain/requests';
import type { Snapshot } from '#Core/Observation/Domain/snapshot';
import { windowChoices, type WindowHours } from '#Core/Observation/Domain/time';
import type { DeploymentStatusSource } from '#Core/Observation/Ports/DeploymentStatusSource';
import type { StatusSource } from '#Core/Observation/Ports/StatusSource';
import { type AwsStatusSourceOptions, makeAwsStatusSource } from '#Infrastructure/Observation/aws';
import {
  alchemyStateOf,
  makeAlchemyDeploymentStatus,
} from '#Infrastructure/Observation/DeploymentStatus/alchemyState.server';
import { makeCloudFormationDeploymentStatus } from '#Infrastructure/Observation/DeploymentStatus/cloudFormation';
import { makeAwsDlqRedrive, makeAwsDlqSource } from '#Infrastructure/Observation/dlq';
import { makeAwsLevelSource } from '#Infrastructure/Observation/levels';
import { makeAwsLogSearch } from '#Infrastructure/Observation/runs';

/** In ms. Requests in this time share one snapshot. */
const cacheTime = 10_000;
/** In ms. Each poll scans the whole ledger table. */
export const requestPollMs = 2_000;

function wire() {
  const name = process.env.DEPLOYMENT ?? defaultDeployment;
  const deployment = deploymentNamed(name);
  const endpoint = process.env.FLOCI_ENDPOINT;
  const options = { name, deployment, ...(endpoint === undefined ? {} : { endpoint }) };
  const source = makeAwsStatusSource(options, deploymentStatusOf(options));
  const logs = makeAwsLogSearch(options);
  const dlq = makeAwsDlqSource(options);
  const dlqRedrive = makeAwsDlqRedrive(options);
  const levels = makeAwsLevelSource(options);

  const ledgerReads = { units: 0 };
  const ledger = ManagedRuntime.make(
    makeRequestLedgerLive(
      DynamoDBDocumentClient.from(
        meterScans(
          new DynamoDBClient({ region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) }),
          ledgerReads
        )
      )
    ).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ REQUEST_LEDGER_TABLE_NAME: resourceNames(deployment.prefix).requestLedgerTable })
        )
      )
    )
  );
  const requests = makeRequestFeed({
    changedSince: (since) =>
      ledger.runPromise(
        Effect.gen(function* () {
          const service = yield* RequestLedger;
          return yield* service.changedSince(since);
        })
      ),
    pollMs: requestPollMs,
    retentionMs: Math.max(...windowChoices) * 3_600_000,
    overlapMs: 10_000,
    readUnits: () => ledgerReads.units,
  });

  const entryOf = (requestID: string) =>
    ledger.runPromise(
      Effect.gen(function* () {
        const service = yield* RequestLedger;
        return yield* service.entryOf(RequestID.make(requestID));
      })
    );

  const cache = new Map<WindowHours, { readonly at: number; readonly snapshot: Promise<Snapshot> }>();

  function snapshotFor(windowHours: WindowHours) {
    const cached = cache.get(windowHours);
    if (cached !== undefined && Date.now() - cached.at < cacheTime) return cached.snapshot;
    const snapshot = source.read(windowHours);
    cache.set(windowHours, { at: Date.now(), snapshot });
    snapshot.catch(() => cache.delete(windowHours));
    return snapshot;
  }

  const status: StatusSource = { read: snapshotFor };

  console.log(`Leads lab of ${name} (${deployment.region})`);
  return { status, requests, entryOf, logs, dlq, dlqRedrive, levels };
}

/** The adapter of the IaC tool that made the deployment: CloudFormation for CDK, the Alchemy state for Alchemy. */
function deploymentStatusOf({ name, deployment, endpoint }: AwsStatusSourceOptions): DeploymentStatusSource {
  const config = { region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) };
  switch (deployment.tool) {
    case 'cdk':
      return makeCloudFormationDeploymentStatus(
        new CloudFormationClient(config),
        resourceNames(deployment.prefix).stack
      );
    case 'alchemy': {
      const lambda = new LambdaClient(config);
      return makeAlchemyDeploymentStatus({
        deploymentName: name,
        prefix: deployment.prefix,
        lambda,
        state: alchemyStateOf({
          deployment,
          credentials: () => lambda.config.credentials(),
          ...(endpoint === undefined ? {} : { endpoint }),
        }),
      });
    }
  }
}

/**
 * Asks DynamoDB for the read units of each scan, and adds them to `reads`. The feed scans the ledger on each poll, so
 * the page can show what its polls cost.
 */
function meterScans(client: DynamoDBClient, reads: { units: number }) {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if (context.commandName !== 'ScanCommand') return next(args);
      (args.input as ScanCommandInput).ReturnConsumedCapacity = 'TOTAL';
      const result = await next(args);
      reads.units += (result.output as ScanCommandOutput).ConsumedCapacity?.CapacityUnits ?? 0;
      return result;
    },
    { step: 'initialize', name: 'meterScans' }
  );
  return client;
}

let services: ReturnType<typeof wire> | undefined;

/** Wires the services on the first call, so that an unknown deployment fails the call and not the server. */
export const labServices = () => (services ??= wire());

/**
 * The services of the dashboard, wired once for each server process. Only the server functions use them.
 *
 * `DEPLOYMENT` selects the deployment (default `production-cdk`). A real deployment reads the AWS credentials of
 * `AWS_PROFILE`. `FLOCI_ENDPOINT` sends every call to an emulator. These are the variables of the lab.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { defaultDeployment, deploymentNamed } from '@leads/shared/deployments';
import { resourceNames } from '@leads/shared/names';
import { ConfigProvider, Effect, Layer, ManagedRuntime } from 'effect';

import { handler as readOrders } from '#Core/Orders/Application/UseCases/ReadOrders/handler';
import type { OrderQuery } from '#Core/Orders/Domain/orderQuery';
import { OrderReader } from '#Core/Orders/Ports/OrderReader';
import { makeOrderCache } from '#Infrastructure/Orders/OrderReader/cache';
import { makeOrderReaderLive } from '#Infrastructure/Orders/OrderReader/live';

/** Requests in this time share one scan of the Orders table. */
const cacheTime = '10 seconds';

function wire() {
  const name = process.env.DEPLOYMENT ?? defaultDeployment;
  const deployment = deploymentNamed(name);
  const endpoint = process.env.FLOCI_ENDPOINT;
  const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) })
  );
  const runtime = ManagedRuntime.make(
    makeOrderReaderLive(dynamo).pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ORDERS_TABLE_NAME: resourceNames(deployment.prefix).ordersTable })
        )
      )
    )
  );
  const cache = runtime.runSync(
    Effect.gen(function* () {
      const reader = yield* OrderReader;
      return yield* makeOrderCache(reader, cacheTime);
    })
  );

  /** Reads one order page. `fresh` skips the cache, for the refresh button. */
  const orderPage = (query: OrderQuery, fresh: boolean) =>
    runtime.runPromiseExit(
      readOrders(query).pipe(Effect.provideService(OrderReader, fresh ? cache.fresh : cache.cached))
    );

  console.log(`Orders dashboard of ${name} (${deployment.region})`);
  return { orderPage };
}

let services: ReturnType<typeof wire> | undefined;

/** Wires the services on the first call, so that an unknown deployment fails the call and not the server. */
export const dashboardServices = () => (services ??= wire());

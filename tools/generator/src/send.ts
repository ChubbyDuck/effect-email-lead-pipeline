/**
 * Sends the workbooks that `gen` made straight to the orders table, without the email and S3 stages.
 *
 *   DEPLOYMENT=<name> pnpm send [--sources business_closure,new_acquisition,mutation]
 *
 * Or use `send:local` (Floci) and `send:production`. Leads of one source go out at the same time.
 * Sources go out one after another. `DEPLOYMENT` is required: it names the orders table.
 * A real deployment reads the AWS credentials of `AWS_PROFILE`.
 */
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toLeadsAndRejectionsFromSheet } from '@leads/pipeline/domain/Transformations/leadSources';
import { ExcelSheetParserLive } from '@leads/pipeline/infrastructure/ExcelSheetParser/live';
import { makeOrderRepositoryLive } from '@leads/pipeline/infrastructure/OrderRepository/live';
import { ExcelSheetParser } from '@leads/pipeline/ports/ExcelSheetParser';
import { OrderRepository } from '@leads/pipeline/ports/OrderRepository';
import { deploymentNamed } from '@leads/shared/deployments';
import { resourceNames } from '@leads/shared/names';
import { Cause, Duration, Effect, Exit, Layer } from 'effect';

import { outputFile, parseSources } from './sources';

/** In ms. A lead that the table does not take in this time counts as failed. */
const orderTimeout = 30_000;

const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const sendOrders = (filePath: string) =>
  Effect.gen(function* () {
    const parser = yield* ExcelSheetParser;
    const orders = yield* OrderRepository;

    const sheet = yield* parser.parse(yield* Effect.promise(() => readFile(filePath)));
    const { leads, leadRejections } = yield* toLeadsAndRejectionsFromSheet(sheet);
    for (const { index, error } of leadRejections) console.log(`Row ${index} is not a lead: ${error.message}`);

    yield* Effect.forEach(
      leads,
      (lead) =>
        orders.store(lead).pipe(
          Effect.timeout(Duration.millis(orderTimeout)),
          Effect.exit,
          Effect.map((exit) => {
            if (Exit.isFailure(exit)) console.log(messageOf(exit.cause));
          })
        ),
      { concurrency: 'unbounded', discard: true }
    );
  });

try {
  const { values } = parseArgs({ options: { sources: { type: 'string' } }, allowPositionals: true });
  const sources = parseSources(values.sources);

  const name = process.env.DEPLOYMENT;
  if (name === undefined) throw new Error('Missing DEPLOYMENT variable');
  const deployment = deploymentNamed(name);
  process.env.ORDERS_TABLE_NAME = resourceNames(deployment.prefix).ordersTable;

  const endpoint = process.env.FLOCI_ENDPOINT;
  const dynamo = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: deployment.region, ...(endpoint === undefined ? {} : { endpoint }) })
  );
  const services = Layer.mergeAll(ExcelSheetParserLive, makeOrderRepositoryLive(dynamo));

  const startedAt = performance.now();
  for (const source of sources) {
    await Effect.runPromise(sendOrders(outputFile(source)).pipe(Effect.provide(services))).catch(() =>
      console.log(`Sending orders of source ${source} failed. Skipping...`)
    );
  }
  console.log(performance.now() - startedAt);
} catch (error) {
  console.log(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

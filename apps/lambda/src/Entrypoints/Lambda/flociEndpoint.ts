import { Config, Effect } from 'effect';

/**
 * The endpoint of Floci, when the Lambda runs in Floci. In AWS, `FLOCI_ENDPOINT` is not set, and the clients use the
 * endpoints of AWS. The environment provider of Effect drops an empty value, so an empty value counts as no value.
 */
export const FlociEndpoint = Config.String('FLOCI_ENDPOINT').pipe(Config.withDefault(undefined));

/** Read one time for each execution environment: the AWS clients at module scope take it. */
export const flociEndpoint = Effect.runSync(FlociEndpoint);

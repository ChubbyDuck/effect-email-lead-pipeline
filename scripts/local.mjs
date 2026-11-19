// Runs a task against the Floci deployment `DEPLOYMENT` (default `local-cdk`): the lab, the dashboard, or the sender.
// The task gets the deployment, the endpoint of its Floci (`flociEndpointOf`: `FLOCI_ENDPOINT` wins when it is set),
// and the `test` credentials of Floci.
// Usage: node scripts/local.mjs <arguments of `turbo run`>
import { spawnSync } from 'node:child_process';

// Node strips the types of this file. It is the one owner of the deployments and their endpoints.
import { deploymentNamed, flociEndpointOf } from '../packages/shared/src/Infrastructure/Shared/deployments.ts';

const name = process.env.DEPLOYMENT || 'local-cdk';
const endpoint = flociEndpointOf(deploymentNamed(name), process.env.FLOCI_ENDPOINT);
if (endpoint === undefined) {
  console.error(`${name} does not run in Floci. Use a script without :local for it.`);
  process.exit(1);
}

const result = spawnSync('turbo', ['run', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DEPLOYMENT: name,
    FLOCI_ENDPOINT: endpoint,
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  },
});
process.exit(result.status ?? 1);

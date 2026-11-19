// Runs an IaC task of the deployment `DEPLOYMENT` with the tool of that deployment: the task of @leads/cdk or of
// @leads/alchemy. `deploy:floci` deploys a Floci deployment (default `local-cdk`). The other tasks take any deployment
// (default `production-cdk`). A Floci deployment goes to the endpoint of its Floci (`flociEndpointOf`).
// Usage: node scripts/infra.mjs <deploy | deploy:floci | diff | destroy> [arguments of the task]
import { spawnSync } from 'node:child_process';

// Node strips the types of this file. It is the one owner of the deployments and their tools.
import {
  defaultDeployment,
  deploymentNamed,
  flociEndpointOf,
  isOnFloci,
} from '../packages/shared/src/Infrastructure/Shared/deployments.ts';

const tasks = ['deploy', 'deploy:floci', 'diff', 'destroy'];
const [task, ...extra] = process.argv.slice(2);
if (!tasks.includes(task)) {
  console.error(`Usage: node scripts/infra.mjs <${tasks.join(' | ')}>`);
  process.exit(1);
}

const isFlociDeploy = task === 'deploy:floci';
const name = process.env.DEPLOYMENT || (isFlociDeploy ? 'local-cdk' : defaultDeployment);
const deployment = deploymentNamed(name);
const onFloci = isOnFloci(deployment);
if (isFlociDeploy && !onFloci) {
  console.error(`infra:deploy:floci deploys a Floci deployment only. Deploy ${name} with infra:deploy.`);
  process.exit(1);
}
// An e2e deployment has an e2e app of its own, which only its e2e suite deploys (test:e2e:floci, test:e2e:alchemy).
if (isFlociDeploy && name.startsWith('e2e-')) {
  console.error(`infra:deploy:floci does not deploy ${name}. Its e2e suite deploys it.`);
  process.exit(1);
}
const endpoint = flociEndpointOf(deployment, process.env.FLOCI_ENDPOINT);
/**
 * The AWS profile of a deployment in AWS: the profile of `aws` and `cdk`, and the name of the Alchemy profile
 * (iac/alchemy/README.md). It comes from `AWS_PROFILE`, with no default. A Floci deployment needs none.
 */
const profile = process.env.AWS_PROFILE;
if (!onFloci && !profile) {
  console.error(`Set AWS_PROFILE to the profile of the AWS project of ${name}.`);
  process.exit(1);
}

/** The arguments of `turbo run` and the environment of the task, for the tool of the deployment. */
function turboTaskOf() {
  if (deployment.tool === 'cdk') {
    if (task === 'destroy') {
      console.error(
        `infra:destroy runs Alchemy only. Destroy the CDK stack of ${name} with \`cdk destroy\` in iac/cdk.`
      );
      process.exit(1);
    }
    // CDK deploys into Floci with a script of its own (iac/cdk/src/deploy-floci.ts), not with `cdk deploy`.
    return {
      args: [
        isFlociDeploy ? 'deploy:floci' : task,
        '--filter=@leads/cdk',
        ...(extra.length > 0 ? ['--', ...extra] : []),
      ],
      env: {},
    };
  }
  // The Alchemy stage of a deployment is its name (`alchemyPipeline.stage`). A real deployment signs in with the
  // Alchemy profile of the README.
  const alchemy = ['--stage', name, ...(onFloci ? [] : ['--profile', profile])];
  // A deploy needs no approval. A destroy asks for it, except on Floci, where everything is disposable.
  const alchemyTask = isFlociDeploy ? 'deploy' : task;
  const yes = alchemyTask === 'deploy' || (alchemyTask === 'destroy' && onFloci) ? ['--yes'] : [];
  return { args: [alchemyTask, '--filter=@leads/alchemy', '--', ...alchemy, ...yes, ...extra], env: {} };
}

const { args, env } = turboTaskOf();
const result = spawnSync('turbo', ['run', ...args], {
  stdio: 'inherit',
  env: { ...process.env, DEPLOYMENT: name, ...(endpoint === undefined ? {} : { FLOCI_ENDPOINT: endpoint }), ...env },
});
process.exit(result.status ?? 1);

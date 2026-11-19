import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** An IaC tool that makes a deployment. */
export type IacTool = 'cdk' | 'alchemy';

/**
 * The deployments of the pipeline: each one is one complete copy, made by one IaC tool in one place (ADR 0002).
 * A deploy, the lab, and the dashboard read their inputs from here, not from the shell that runs them.
 * Select one with `DEPLOYMENT=<name>`. The deployments in AWS hold example values here: the values of a real AWS project
 * come from the local values file (`deployments.local.json`, ADR 0004).
 */
export interface Deployment {
  /** The IaC tool that makes this deployment. Only that tool deploys it: see `deploymentFor`. */
  readonly tool: IacTool;
  readonly account: string;
  /** The Region of the AWS project. The new AWS experience permits only this one. */
  readonly region: string;
  /** The first part of the name of each resource. See `resourceNames`. */
  readonly prefix: string;
  /** See `LeadsStackProps.inboxAddress`. */
  readonly inboxAddress?: string;
  /** The first whitelist in AppConfig. Change the live whitelist in AppConfig, not here. */
  readonly senderWhitelist: readonly string[];
  /**
   * The port of the Floci of a Floci deployment on this machine. Each Floci deployment has a port of its own, so that
   * the deployments can run at the same time. See `flociEndpointOf`.
   */
  readonly flociPort?: number;
}

const owner = 'owner@example.com';
const floci = { account: '000000000000', region: 'us-east-1' } as const;
const production = { account: '123456789012', region: 'eu-north-1' } as const;

/** The committed deployments, with example values for the deployments in AWS. */
const examples = {
  /** The CDK stack in Floci on this machine. */
  'local-cdk': { tool: 'cdk', ...floci, flociPort: 4566, prefix: 'leads-local', senderWhitelist: [owner] },
  /** The live CDK stack. */
  'production-cdk': {
    tool: 'cdk',
    ...production,
    inboxAddress: 'noreply@cdk.ses.example.com',
    prefix: 'example-leads',
    senderWhitelist: [owner],
  },
  /** The CDK stack of the e2e suite, in its own Floci. */
  'e2e-cdk': { tool: 'cdk', ...floci, flociPort: 4567, prefix: 'leads-e2e', senderWhitelist: [owner] },
  /** The Alchemy stack in Floci on this machine, next to the Floci of `local-cdk`. */
  'local-alchemy': {
    tool: 'alchemy',
    ...floci,
    flociPort: 4568,
    prefix: 'leads-local-alchemy',
    senderWhitelist: [owner],
  },
  /** The live Alchemy stack, next to the live CDK stack. */
  'production-alchemy': {
    tool: 'alchemy',
    ...production,
    inboxAddress: 'noreply@alchemy.ses.example.com',
    prefix: 'example-leads-alchemy',
    senderWhitelist: [owner],
  },
  /** The Alchemy stack of the e2e suite, in its own Floci. */
  'e2e-alchemy': { tool: 'alchemy', ...floci, flociPort: 4569, prefix: 'leads-e2e-alchemy', senderWhitelist: [owner] },
} as const satisfies Record<string, Deployment>;

export type DeploymentName = keyof typeof examples;

/** The fields of a deployment in AWS that the local values file can set: the values of one real AWS project. */
const localFields = ['account', 'inboxAddress', 'prefix', 'senderWhitelist'] as const;
type LocalField = (typeof localFields)[number];

/** A deployment after the local values file: the fields of `localFields` can differ from the examples. */
type WithLocalValues<D> = Omit<D, LocalField> & Pick<Deployment, LocalField>;

/** The deployments of this machine, by name. */
export type Deployments = { readonly [K in DeploymentName]: WithLocalValues<(typeof examples)[K]> };

/** The file at the root of the repo that holds the values of a real AWS project. Git ignores it. */
export const localValuesFile = 'deployments.local.json';

/** The root of the repo: the first folder up from `from` with `pnpm-workspace.yaml`. */
function repoRootFrom(from: string): string | undefined {
  for (let folder = from; ; folder = dirname(folder)) {
    if (existsSync(join(folder, 'pnpm-workspace.yaml'))) return folder;
    if (dirname(folder) === folder) return undefined;
  }
}

/**
 * The deployments with the values of the local values file, if the root of the repo has one. The file can set only the
 * fields of `localFields`, and only for a deployment in AWS: a Floci deployment keeps its committed values.
 */
export function withLocalValues(committed: Deployments, file: string | undefined): Deployments {
  if (file === undefined || !existsSync(file)) return committed;
  const local: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof local !== 'object' || local === null) throw new Error(`${file} must hold one object of deployments`);
  const result: Record<string, Deployment> = { ...committed };
  for (const [name, values] of Object.entries(local)) {
    if (!Object.hasOwn(committed, name)) throw new Error(`${file} names the unknown deployment ${name}`);
    const deployment: Deployment = committed[name as DeploymentName];
    if (isOnFloci(deployment))
      throw new Error(`${file} sets ${name}, but a Floci deployment keeps its committed values`);
    const unknown = Object.keys(values as object).filter(
      (field) => !(localFields as readonly string[]).includes(field)
    );
    if (unknown.length > 0) throw new Error(`${file} sets the unknown fields ${unknown.join(', ')} of ${name}`);
    result[name] = { ...deployment, ...(values as Partial<Pick<Deployment, LocalField>>) };
  }
  return result as Deployments;
}

const root = repoRootFrom(process.cwd());

/**
 * The deployments of this machine: the committed table, with the local values file of the repo when it exists. A test
 * sees only the committed values, so the suite gives the same result on each machine.
 */
export const deployments: Deployments = withLocalValues(
  examples,
  process.env.VITEST === undefined && root !== undefined ? join(root, localValuesFile) : undefined
);

/** The deployment that a deploy, the lab, and the dashboard use when `DEPLOYMENT` is not set. */
export const defaultDeployment: DeploymentName = 'production-cdk';

/** Whether the deployment runs in a Floci emulator, not in AWS. */
export function isOnFloci(deployment: Deployment): boolean {
  return deployment.account === floci.account;
}

/**
 * The endpoint of the Floci of a Floci deployment, as this machine reaches it: `override` (the value of
 * `FLOCI_ENDPOINT`) when it is set, else the `flociPort` of the deployment. A deployment in AWS has no endpoint, so it
 * ignores `override`.
 */
export function flociEndpointOf(deployment: Deployment, override?: string): string | undefined {
  if (!isOnFloci(deployment)) return undefined;
  if (override !== undefined && override !== '') return override;
  return deployment.flociPort === undefined ? undefined : `http://127.0.0.1:${deployment.flociPort}`;
}

export function deploymentNamed(name: unknown): Deployment {
  if (typeof name === 'string' && Object.hasOwn(deployments, name)) return deployments[name as DeploymentName];
  throw new Error(`Unknown deployment: ${String(name)}. Use one of: ${Object.keys(deployments).join(', ')}`);
}

/**
 * The deployment `name`, for a deploy with `tool`. It refuses a deployment of a different tool, so that one tool never
 * makes a stack with the prefix of a different tool.
 */
export function deploymentFor(name: unknown, tool: IacTool): Deployment {
  const deployment = deploymentNamed(name);
  if (deployment.tool === tool) return deployment;
  const ofTool = Object.entries(deployments).flatMap(([other, { tool: its }]) => (its === tool ? [other] : []));
  throw new Error(
    `The deployment ${String(name)} belongs to ${deployment.tool}, not to ${tool}. The deployments of ${tool} are: ${ofTool.join(', ')}`
  );
}

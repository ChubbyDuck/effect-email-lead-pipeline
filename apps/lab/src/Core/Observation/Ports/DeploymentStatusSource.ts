import { withReason } from '@leads/shared/utils';

import type { DeploymentStatus, DeploymentTool } from '#Core/Observation/Domain/snapshot';

/** The IaC tool of the deployment could not give its status. */
export class DeploymentStatusNotRead extends Error {
  constructor(
    readonly tool: DeploymentTool,
    readonly deploymentName: string,
    readonly reason: unknown
  ) {
    super(withReason(`The ${tool} status of ${deploymentName} was not read`, reason));
  }
}

/** The tool has no record of the deployment. */
export class DeploymentNotFound extends Error {
  constructor(
    readonly tool: DeploymentTool,
    readonly deploymentName: string
  ) {
    super(`The ${tool} deployment ${deploymentName} does not exist`);
  }
}

/**
 * The port that reads the status of the deployment from the IaC tool that made it. Each tool has its own adapter, and
 * the composition root picks one by the tool of the deployment.
 */
export interface DeploymentStatusSource {
  readonly read: () => Promise<DeploymentStatus>;
}

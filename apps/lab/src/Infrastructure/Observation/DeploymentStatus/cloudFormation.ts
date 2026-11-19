import { type CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

import type { DeploymentPhase, DeploymentStatus } from '#Core/Observation/Domain/snapshot';
import {
  DeploymentNotFound,
  DeploymentStatusNotRead,
  type DeploymentStatusSource,
} from '#Core/Observation/Ports/DeploymentStatusSource';

/**
 * The phase of a CloudFormation stack status. A failure or a rollback comes first, so that `UPDATE_ROLLBACK_COMPLETE`
 * is `failed`, not `complete`.
 */
export function cloudFormationPhase(status: string): DeploymentPhase {
  if (/FAILED|ROLLBACK/.test(status)) return 'failed';
  if (status.endsWith('IN_PROGRESS')) return 'in-progress';
  return 'complete';
}

/** The status of the CDK deployment: its CloudFormation stack `stackName`. */
export function makeCloudFormationDeploymentStatus(
  cloudFormation: CloudFormationClient,
  stackName: string
): DeploymentStatusSource {
  return {
    async read(): Promise<DeploymentStatus> {
      const { Stacks } = await cloudFormation
        .send(new DescribeStacksCommand({ StackName: stackName }))
        .catch((error: unknown) => {
          throw new DeploymentStatusNotRead('cdk', stackName, error);
        });
      const stack = Stacks?.[0];
      if (stack === undefined) throw new DeploymentNotFound('cdk', stackName);
      const status = stack.StackStatus ?? 'UNKNOWN';
      const updatedAt = stack.LastUpdatedTime ?? stack.CreationTime;
      return {
        tool: 'cdk',
        name: stackName,
        phase: cloudFormationPhase(status),
        status,
        ...(stack.StackStatusReason !== undefined && { reason: stack.StackStatusReason }),
        ...(updatedAt !== undefined && { updatedAt: updatedAt.toISOString() }),
      };
    },
  };
}

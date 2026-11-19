import { type CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { beforeEach, expect, test, vi } from 'vitest';

import { DeploymentNotFound, DeploymentStatusNotRead } from '#Core/Observation/Ports/DeploymentStatusSource';

import { cloudFormationPhase, makeCloudFormationDeploymentStatus } from './cloudFormation';

const send = vi.fn();
const cloudFormation = { send } as unknown as CloudFormationClient;
const source = makeCloudFormationDeploymentStatus(cloudFormation, 'LeadsStack-leads');

beforeEach(() => {
  send.mockReset();
});

test.each([
  ['CREATE_COMPLETE', 'complete'],
  ['UPDATE_COMPLETE', 'complete'],
  ['UPDATE_IN_PROGRESS', 'in-progress'],
  ['UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'in-progress'],
  ['REVIEW_IN_PROGRESS', 'in-progress'],
  ['UPDATE_FAILED', 'failed'],
  ['CREATE_FAILED', 'failed'],
  ['ROLLBACK_COMPLETE', 'failed'],
  ['UPDATE_ROLLBACK_COMPLETE', 'failed'],
  ['UPDATE_ROLLBACK_IN_PROGRESS', 'failed'],
  ['UNKNOWN', 'complete'],
] as const)('maps the stack status %s to the phase %s', (status, phase) => {
  expect(cloudFormationPhase(status)).toBe(phase);
});

test('reads the stack of the deployment, with its phase, its reason, and the time of its last update', async () => {
  send.mockResolvedValue({
    Stacks: [
      {
        StackName: 'LeadsStack-leads',
        StackStatus: 'UPDATE_ROLLBACK_COMPLETE',
        StackStatusReason: 'Resource update cancelled',
        CreationTime: new Date('2026-10-01T10:00:00Z'),
        LastUpdatedTime: new Date('2026-10-09T13:29:00Z'),
      },
    ],
  });

  await expect(source.read()).resolves.toEqual({
    tool: 'cdk',
    name: 'LeadsStack-leads',
    phase: 'failed',
    status: 'UPDATE_ROLLBACK_COMPLETE',
    reason: 'Resource update cancelled',
    updatedAt: '2026-10-09T13:29:00.000Z',
  });
  const [command] = send.mock.calls[0] as [DescribeStacksCommand];
  expect(command).toBeInstanceOf(DescribeStacksCommand);
  expect(command.input).toEqual({ StackName: 'LeadsStack-leads' });
});

test('takes the time of the creation of a stack that was never updated', async () => {
  send.mockResolvedValue({
    Stacks: [{ StackStatus: 'CREATE_COMPLETE', CreationTime: new Date('2026-10-01T10:00:00Z') }],
  });

  await expect(source.read()).resolves.toEqual({
    tool: 'cdk',
    name: 'LeadsStack-leads',
    phase: 'complete',
    status: 'CREATE_COMPLETE',
    updatedAt: '2026-10-01T10:00:00.000Z',
  });
});

test('keeps the failure of CloudFormation as the reason', async () => {
  const original = Object.assign(new Error('Stack with id LeadsStack-leads does not exist'), {
    name: 'ValidationError',
  });
  send.mockImplementation(async () => {
    throw original;
  });

  const error = await source.read().catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(DeploymentStatusNotRead);
  expect((error as DeploymentStatusNotRead).reason).toBe(original);
  expect((error as DeploymentStatusNotRead).message).toContain('Stack with id LeadsStack-leads does not exist');
});

test('fails when CloudFormation gives no stack', async () => {
  send.mockResolvedValue({ Stacks: [] });

  await expect(source.read()).rejects.toBeInstanceOf(DeploymentNotFound);
});

test('gives no time for a stack that has none', async () => {
  send.mockResolvedValue({ Stacks: [{ StackStatus: 'CREATE_IN_PROGRESS' }] });

  await expect(source.read()).resolves.not.toHaveProperty('updatedAt');
});

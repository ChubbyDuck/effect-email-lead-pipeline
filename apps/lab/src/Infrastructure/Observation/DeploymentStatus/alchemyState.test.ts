import type { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Effect } from 'effect';
import { beforeEach, expect, test, vi } from 'vitest';

import { DeploymentStatusNotRead } from '#Core/Observation/Ports/DeploymentStatusSource';

import {
  alchemyPhase,
  type AlchemyStateReads,
  type CatalogStatus,
  makeAlchemyDeploymentStatus,
} from './alchemyState.server';

const send = vi.fn();
const lambda = { send } as unknown as LambdaClient;

/** The JSON of a resource record, as the store keeps it. */
const resource = (status: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: 'resource', status, props: {}, attr: {}, ...extra });

/** A fake of the store: one stage with a catalog status and records. */
function stateOf(catalog: CatalogStatus, records: Record<string, string> = {}) {
  const status = vi.fn<AlchemyStateReads['status']>(() => Effect.succeed(catalog));
  const readStage = vi.fn<AlchemyStateReads['readStage']>(() =>
    Effect.succeed({ records: new Map(Object.entries(records)), output: undefined })
  );
  return { status, readStage };
}

const sourceOf = (state: AlchemyStateReads) =>
  makeAlchemyDeploymentStatus({ deploymentName: 'production-alchemy', prefix: 'leads-alchemy', state, lambda });

/** Each function answers with its time of change. A function without a time does not exist. */
function functions(times: Partial<Record<string, string>>) {
  send.mockImplementation(async (command: GetFunctionConfigurationCommand) => {
    const time = times[command.input.FunctionName ?? ''];
    if (time === undefined) {
      throw Object.assign(new Error('Function not found'), { name: 'ResourceNotFoundException' });
    }
    return { FunctionName: command.input.FunctionName, LastModified: time };
  });
}

const allFunctions = {
  'leads-alchemy-inbox': '2026-11-17T18:00:00.000+0000',
  'leads-alchemy-lead-sources': '2026-11-17T18:05:00.000+0000',
  'leads-alchemy-leads': '2026-11-17T17:00:00.000+0000',
};

beforeEach(() => {
  send.mockReset();
});

test.each([
  { catalog: 'active', statuses: ['created', 'updated', 'replaced'], phase: 'complete' },
  { catalog: 'active', statuses: [], phase: 'complete' },
  { catalog: 'active', statuses: ['created', 'creating'], phase: 'in-progress' },
  { catalog: 'active', statuses: ['updating'], phase: 'in-progress' },
  { catalog: 'active', statuses: ['deleting'], phase: 'in-progress' },
  { catalog: 'active', statuses: ['replacing'], phase: 'in-progress' },
  { catalog: 'rolled-back', statuses: ['created'], phase: 'failed' },
  { catalog: 'rolled-back', statuses: ['updating'], phase: 'failed' },
  { catalog: 'destroyed', statuses: [], phase: 'failed' },
  { catalog: undefined, statuses: [], phase: 'failed' },
] as const)('maps a $catalog stage with the resources $statuses to $phase', ({ catalog, statuses, phase }) => {
  expect(alchemyPhase(catalog, statuses)).toBe(phase);
});

test('reads the stage of the deployment in the Alchemy stack, and takes the time of the newest function change', async () => {
  const state = stateOf('active', { Inbox: resource('created'), LeadHandler: resource('updated') });
  functions(allFunctions);

  await expect(sourceOf(state).read()).resolves.toEqual({
    tool: 'alchemy',
    name: 'LeadsStack/production-alchemy',
    phase: 'complete',
    status: 'active',
    updatedAt: '2026-11-17T18:05:00.000Z',
  });
  expect(state.status).toHaveBeenCalledWith('LeadsStack', 'production-alchemy');
  expect(state.readStage).toHaveBeenCalledWith('LeadsStack', 'production-alchemy');
  const commands = send.mock.calls.map((call) => call[0] as GetFunctionConfigurationCommand);
  expect(commands.map((command) => command.input.FunctionName)).toEqual(Object.keys(allFunctions));
});

test('names the resources that a deploy changes now', async () => {
  const state = stateOf('active', {
    Inbox: resource('created'),
    LeadHandler: resource('updating'),
    LeadsQueue: resource('creating'),
  });
  functions(allFunctions);

  await expect(sourceOf(state).read()).resolves.toMatchObject({
    phase: 'in-progress',
    status: 'creating, updating',
    reason: 'LeadHandler is updating, LeadsQueue is creating',
  });
});

test('ignores the record of an action', async () => {
  const state = stateOf('active', { Seed: JSON.stringify({ kind: 'action', status: 'running' }) });
  functions(allFunctions);

  await expect(sourceOf(state).read()).resolves.toMatchObject({ phase: 'complete', status: 'active' });
});

test('gives a missing stage as failed, with no time', async () => {
  functions({});

  await expect(sourceOf(stateOf(undefined)).read()).resolves.toEqual({
    tool: 'alchemy',
    name: 'LeadsStack/production-alchemy',
    phase: 'failed',
    status: 'missing',
    reason: 'The Alchemy state has no stage production-alchemy of LeadsStack.',
  });
  expect(send).not.toHaveBeenCalled();
});

test('gives a rolled-back stage as failed', async () => {
  functions(allFunctions);

  await expect(sourceOf(stateOf('rolled-back', { Inbox: resource('created') })).read()).resolves.toMatchObject({
    phase: 'failed',
    status: 'rolled-back',
  });
});

test('takes the time of the functions that exist', async () => {
  functions({ 'leads-alchemy-leads': '2026-11-17T17:00:00.000+0000' });

  await expect(sourceOf(stateOf('active')).read()).resolves.toMatchObject({ updatedAt: '2026-11-17T17:00:00.000Z' });
});

test('keeps the failure of the state as the reason', async () => {
  const original = new Error('The DynamoDB state table alchemy-state was not found');
  const state = { ...stateOf('active'), status: () => Effect.fail(original) } as unknown as AlchemyStateReads;

  const error = await sourceOf(state)
    .read()
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(DeploymentStatusNotRead);
  expect((error as DeploymentStatusNotRead).reason).toBe(original);
});

test('keeps the failure of Lambda as the reason', async () => {
  const original = Object.assign(new Error('Not authorized'), { name: 'AccessDeniedException' });
  send.mockImplementation(async () => {
    throw original;
  });

  const error = await sourceOf(stateOf('active'))
    .read()
    .catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(DeploymentStatusNotRead);
  expect((error as DeploymentStatusNotRead).reason).toBe(original);
});

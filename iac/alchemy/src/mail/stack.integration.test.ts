import { deployments } from '@leads/shared/deployments';
import { mailNames } from '@leads/shared/names';
import * as Alchemy from 'alchemy';
import * as Alchemist from 'alchemy/Alchemist';
import * as Effect from 'effect/Effect';
import { beforeAll, expect, test } from 'vitest';

import { flociProviders } from '#target';

import { leadsMail } from './stack';

/**
 * The plan of the mail stack against the Floci image of Alchemy at `FLOCI_ENDPOINT`, with in-memory state: what a first
 * deploy makes. The plan applies nothing.
 */
const planOfMail = () => {
  const endpoint = process.env.FLOCI_ENDPOINT;
  if (endpoint === undefined) throw new Error('Set FLOCI_ENDPOINT to the endpoint of a Floci image of Alchemy');
  return Effect.runPromise(
    Alchemist.plan({
      stack: Alchemy.Stack(
        mailNames.stack,
        { providers: flociProviders(deployments['e2e-alchemy'], endpoint), state: Alchemy.inMemoryState() },
        leadsMail
      ),
      operation: 'deploy',
      stage: mailNames.stage,
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped)
  );
};

let plan: Awaited<ReturnType<typeof planOfMail>>;

beforeAll(async () => {
  plan = await planOfMail();
}, 60_000);

test('makes only the shared rule set leads-mail and its activation, and protects both', () => {
  const resources = Object.entries(plan.native.resources).map(([id, node]) => ({
    id,
    type: node.resource.Type,
    action: node.action,
    removalPolicy: node.resource.RemovalPolicy,
    props: 'props' in node ? node.props : undefined,
  }));

  expect(resources).toEqual([
    {
      id: 'RuleSet',
      type: 'AWS.SES.ReceiptRuleSet',
      action: 'create',
      removalPolicy: 'protect',
      props: { ruleSetName: 'leads-mail' },
    },
    {
      id: 'Activation',
      type: 'AWS.SES.ActiveReceiptRuleSet',
      action: 'create',
      removalPolicy: 'protect',
      props: { ruleSetName: expect.anything() },
    },
  ]);
});

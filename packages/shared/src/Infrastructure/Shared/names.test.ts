import { expect, test } from 'vitest';

import { alchemyPipeline, mailNames, resourceNames } from './names';

// The names of the live stack, as the CDK stack wrote them before the naming contract.
test('names the resources of a deployment after its prefix', () => {
  const names = resourceNames('example-leads');

  expect(names.stack).toBe('LeadsStack-example-leads');
  expect([names.bucket('inbox'), names.bucket('leadSources')]).toEqual([
    'example-leads-inbox',
    'example-leads-lead-sources',
  ]);
  expect([names.queue('inbox'), names.queue('leadSources'), names.queue('leads')]).toEqual([
    'example-leads-inbox',
    'example-leads-lead-sources',
    'example-leads-leads',
  ]);
  expect([names.dlq('inbox'), names.dlq('leadSources'), names.dlq('leads')]).toEqual([
    'example-leads-inbox-dlq',
    'example-leads-lead-sources-dlq',
    'example-leads-leads-dlq',
  ]);
  expect([names.functionName('inbox'), names.functionName('leadSources'), names.functionName('leads')]).toEqual([
    'example-leads-inbox',
    'example-leads-lead-sources',
    'example-leads-leads',
  ]);
  expect(names.ordersTable).toBe('example-leads-orders');
  expect(names.requestLedgerTable).toBe('example-leads-request-ledger');
  expect(names.appConfigApplication).toBe('example-leads');
  expect(names.appConfigDeploymentStrategy).toBe('example-leads-at-once');
  expect(names.mailRule).toBe('example-leads-inbox');
  expect(names.e2eBucket).toBe('example-leads-e2e');
});

test('names the functions of an Alchemy deployment after its prefix and the stage slug', () => {
  const names = resourceNames('example-leads-alchemy');

  expect([names.functionName('inbox'), names.functionName('leadSources'), names.functionName('leads')]).toEqual([
    'example-leads-alchemy-inbox',
    'example-leads-alchemy-lead-sources',
    'example-leads-alchemy-leads',
  ]);
});

test('makes each Alchemy deployment a stage of the Alchemy stack, named after the deployment', () => {
  expect(alchemyPipeline.stack).toBe('LeadsStack');
  expect(alchemyPipeline.stage('production-alchemy')).toBe('production-alchemy');
  expect(alchemyPipeline.stage('local-alchemy')).toBe('local-alchemy');
  expect(alchemyPipeline.stage('e2e-alchemy')).toBe('e2e-alchemy');
});

test('names the mail stack without a prefix, because the account has one', () => {
  expect(mailNames).toEqual({ ruleSet: 'leads-mail', stack: 'LeadsMail', stage: 'mail' });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import {
  deploymentFor,
  deploymentNamed,
  deployments,
  flociEndpointOf,
  isOnFloci,
  type Deployment,
  type DeploymentName,
  type IacTool,
  withLocalValues,
} from './deployments';

test('deploys production-cdk to the Region of the AWS project, with the prefix of the live stack', () => {
  expect(deploymentNamed('production-cdk')).toMatchObject({
    tool: 'cdk',
    account: '123456789012',
    region: 'eu-north-1',
    prefix: 'example-leads',
    inboxAddress: 'noreply@cdk.ses.example.com',
  });
});

test('deploys local-cdk and e2e-cdk to Floci', () => {
  expect(deploymentNamed('local-cdk')).toMatchObject({ tool: 'cdk', account: '000000000000', prefix: 'leads-local' });
  expect(deploymentNamed('e2e-cdk')).toMatchObject({ tool: 'cdk', account: '000000000000', prefix: 'leads-e2e' });
});

test('deploys production-alchemy to the account and the Region of production-cdk, with an inbox domain of its own', () => {
  const { account, region } = deploymentNamed('production-cdk');

  expect(deploymentNamed('production-alchemy')).toEqual({
    tool: 'alchemy',
    account,
    region,
    inboxAddress: 'noreply@alchemy.ses.example.com',
    prefix: 'example-leads-alchemy',
    senderWhitelist: deploymentNamed('production-cdk').senderWhitelist,
  });
});

test('deploys local-alchemy and e2e-alchemy to Floci', () => {
  expect(deploymentNamed('local-alchemy')).toMatchObject({
    tool: 'alchemy',
    account: '000000000000',
    region: 'us-east-1',
    prefix: 'leads-local-alchemy',
  });
  expect(deploymentNamed('e2e-alchemy')).toMatchObject({
    tool: 'alchemy',
    account: '000000000000',
    region: 'us-east-1',
    prefix: 'leads-e2e-alchemy',
  });
});

test.each([
  ['production-alchemy', 'production-cdk'],
  ['local-alchemy', 'local-cdk'],
  ['e2e-alchemy', 'e2e-cdk'],
] as const)('gives %s the sender whitelist of %s', (alchemy, cdk) => {
  expect(deployments[alchemy].senderWhitelist).toEqual(deployments[cdk].senderWhitelist);
});

test('runs only the production deployments in AWS', () => {
  const inAws = Object.entries(deployments).flatMap(([name, deployment]) => (isOnFloci(deployment) ? [] : [name]));

  expect(inAws).toEqual(['production-cdk', 'production-alchemy']);
});

test('keeps each deployment in its own resources', () => {
  const prefixes = Object.values(deployments).map((deployment) => deployment.prefix);

  expect(new Set(prefixes).size).toBe(prefixes.length);
});

test('gives each Floci deployment a port of its own, so that they can run at the same time', () => {
  const ports = Object.values<Deployment>(deployments).flatMap((deployment) =>
    isOnFloci(deployment) ? [deployment.flociPort] : []
  );

  expect(ports).toEqual([4566, 4567, 4568, 4569]);
});

test('reaches local-cdk on port 4566 and local-alchemy on port 4568', () => {
  expect(flociEndpointOf(deployments['local-cdk'])).toBe('http://127.0.0.1:4566');
  expect(flociEndpointOf(deployments['local-alchemy'])).toBe('http://127.0.0.1:4568');
});

test('reaches a Floci deployment at FLOCI_ENDPOINT when it is set', () => {
  expect(flociEndpointOf(deployments['local-alchemy'], 'http://127.0.0.1:4999')).toBe('http://127.0.0.1:4999');
  expect(flociEndpointOf(deployments['local-alchemy'], '')).toBe('http://127.0.0.1:4568');
});

test('gives a deployment in AWS no Floci endpoint, even with FLOCI_ENDPOINT', () => {
  expect(flociEndpointOf(deployments['production-cdk'])).toBeUndefined();
  expect(flociEndpointOf(deployments['production-alchemy'], 'http://127.0.0.1:4566')).toBeUndefined();
});

test('names each deployment after its tool', () => {
  for (const [name, deployment] of Object.entries(deployments))
    expect(name).toMatch(new RegExp(`-${deployment.tool}$`));
});

test.each([['production'], ['local'], ['toString'], [undefined]])('refuses the unknown deployment %s', (name) => {
  expect(() => deploymentNamed(name)).toThrow('Unknown deployment');
});

test.each<[DeploymentName, IacTool]>([
  ['production-cdk', 'cdk'],
  ['e2e-cdk', 'cdk'],
  ['production-alchemy', 'alchemy'],
  ['local-alchemy', 'alchemy'],
])('gives %s to %s', (name, tool) => {
  expect(deploymentFor(name, tool)).toBe(deployments[name]);
});

test('refuses a deployment of a different tool, and names its tool', () => {
  expect(() => deploymentFor('production-alchemy', 'cdk')).toThrow(
    'The deployment production-alchemy belongs to alchemy, not to cdk. The deployments of cdk are: local-cdk, production-cdk, e2e-cdk'
  );
  expect(() => deploymentFor('local-cdk', 'alchemy')).toThrow(
    'The deployment local-cdk belongs to cdk, not to alchemy.'
  );
});

test('refuses an unknown deployment for a tool', () => {
  expect(() => deploymentFor('production', 'cdk')).toThrow('Unknown deployment');
});

describe('withLocalValues', () => {
  /** A local values file with `content`, in a folder of its own. */
  const localFile = (content: unknown) => {
    const file = join(mkdtempSync(join(tmpdir(), 'leads-deployments-')), 'deployments.local.json');
    writeFileSync(file, JSON.stringify(content));
    return file;
  };

  test('keeps the committed values when the repo has no local values file', () => {
    expect(withLocalValues(deployments, undefined)).toBe(deployments);
    expect(withLocalValues(deployments, join(tmpdir(), 'no-such-folder', 'deployments.local.json'))).toBe(deployments);
  });

  test('takes the values of a real AWS project for a deployment in AWS, and keeps its other fields', () => {
    const values = {
      account: '210987654321',
      inboxAddress: 'leads@mail.example.org',
      prefix: 'acme-leads',
      senderWhitelist: ['ops@example.org'],
    };

    const local = withLocalValues(deployments, localFile({ 'production-cdk': values }));

    expect(local['production-cdk']).toEqual({ tool: 'cdk', region: 'eu-north-1', ...values });
    expect(local['production-alchemy']).toBe(deployments['production-alchemy']);
  });

  test('refuses an unknown deployment', () => {
    expect(() => withLocalValues(deployments, localFile({ production: { prefix: 'acme-leads' } }))).toThrow(
      'names the unknown deployment production'
    );
  });

  test('refuses a Floci deployment', () => {
    expect(() => withLocalValues(deployments, localFile({ 'local-cdk': { prefix: 'acme-leads' } }))).toThrow(
      'a Floci deployment keeps its committed values'
    );
  });

  test('refuses a field that is not a value of the AWS project', () => {
    expect(() => withLocalValues(deployments, localFile({ 'production-cdk': { region: 'us-east-1' } }))).toThrow(
      'sets the unknown fields region of production-cdk'
    );
  });
});

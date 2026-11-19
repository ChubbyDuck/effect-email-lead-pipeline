import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildStartApp } from '@leads/vite-config/startBuild';
import { afterEach, expect, test } from 'vitest';

const app = import.meta.dirname;
const outDirs: string[] = [];

async function outDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'lab-build-'));
  outDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(outDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('the clean build passes, and its client bundle has no AWS client and no composition root', async () => {
  const client = await buildStartApp(app, await outDir());

  // The SDK names each client in a string, so the names stay in a minified bundle.
  expect(client).not.toContain('DynamoDBClient');
  expect(client).not.toContain('SQSClient');
  expect(client).not.toContain('Leads lab of');
  // The service key of the AWS environment of Alchemy: only the Alchemy adapter brings it.
  expect(client).not.toContain('AWS::Environment');
}, 120_000);

test.each([
  ['the composition root', 'src/Entrypoints/Lab/services.server.ts'],
  ['the Alchemy adapter', 'src/Infrastructure/Observation/DeploymentStatus/alchemyState.server.ts'],
])(
  'the build fails when a plain file of the core gives %s to the client',
  async (_, module) => {
    const serverModule = path.join(app, module);

    await expect(buildStartApp(app, await outDir(), { serverModule })).rejects.toThrow(
      'Import denied in client environment'
    );
  },
  120_000
);

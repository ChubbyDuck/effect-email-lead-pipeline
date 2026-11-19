import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildStartApp } from '@leads/vite-config/startBuild';
import { afterEach, expect, test } from 'vitest';

const app = import.meta.dirname;
const outDirs: string[] = [];

async function outDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dashboard-build-'));
  outDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(outDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('the clean build passes, and its client bundle has no DynamoDB client and no composition root', async () => {
  const client = await buildStartApp(app, await outDir());

  expect(client).not.toContain('DynamoDB');
  expect(client).not.toContain('Orders dashboard of');
}, 120_000);

test('the build fails when a plain file of the core gives a .server file to the client', async () => {
  const serverModule = path.join(app, 'src/Entrypoints/Dashboard/services.server.ts');

  await expect(buildStartApp(app, await outDir(), { serverModule })).rejects.toThrow(
    'Import denied in client environment'
  );
}, 120_000);

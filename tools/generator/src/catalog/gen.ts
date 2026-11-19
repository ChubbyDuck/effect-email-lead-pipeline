/**
 * Makes one file for each case of the input catalog, in `output/catalog/` of the generator. The folder is git-ignored and is
 * made again on every run. Its `README.md` tells where to send each file and what to expect.
 *
 *   pnpm catalog [--deployment production-cdk|local-cdk|local-alchemy] [--rows 2] [--seed 1234] [--skip-large]
 *
 * `--seed` makes the same fake leads again. Without it, each run makes new leads, so a resent catalog makes new orders.
 * `--skip-large` leaves out the files of many megabytes.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { defaultDeployment, deploymentNamed } from '@leads/shared/deployments';
import { resourceNames } from '@leads/shared/names';

import { enFaker, faker } from '../faker';
import { cases, type Context, fileName } from './cases';
import { folders, type Entry, manifest, readme } from './render';

export const outputDirectory = path.resolve(import.meta.dirname, '../../output/catalog');

try {
  const { values } = parseArgs({
    options: {
      deployment: { type: 'string', default: defaultDeployment },
      rows: { type: 'string', default: '2' },
      seed: { type: 'string' },
      'skip-large': { type: 'boolean', default: false },
    },
  });
  const deployment = deploymentNamed(values.deployment);
  const names = resourceNames(deployment.prefix);
  const rows = Number(values.rows);
  if (!Number.isInteger(rows) || rows < 1 || rows > 10)
    throw new Error(`--rows must be a whole number from 1 to 10. Got: ${values.rows}`);
  const seed = values.seed === undefined ? Math.floor(Math.random() * 1_000_000) : Number(values.seed);
  faker.seed(seed);
  enFaker.seed(seed);

  const context: Context = {
    rows,
    owner: deployment.senderWhitelist[0]!,
    recipient: deployment.inboxAddress ?? `inbox@${deployment.prefix}.local`,
    region: deployment.region,
    buckets: { inbox: names.bucket('inbox'), leadSources: names.bucket('leadSources') },
  };

  rmSync(outputDirectory, { recursive: true, force: true });
  const entries: Entry[] = [];
  for (const item of cases) {
    if (item.large && values['skip-large']) continue;
    const file = fileName(item);
    const folder = folders[item.destination].folder;
    mkdirSync(path.join(outputDirectory, folder), { recursive: true });
    writeFileSync(path.join(outputDirectory, folder, file), item.build(context));
    entries.push({ item, file: `${folder}/${file}`, key: item.key?.(file) ?? file });
    process.stdout.write('.');
  }

  const settings = {
    deployment: values.deployment!,
    seed,
    rows,
    skipLarge: values['skip-large']!,
    context,
    prefix: deployment.prefix,
  };
  writeFileSync(path.join(outputDirectory, 'README.md'), readme(entries, settings));
  writeFileSync(
    path.join(outputDirectory, 'manifest.json'),
    `${JSON.stringify(manifest(entries, settings), null, 2)}\n`
  );
  console.log(
    `\n${entries.length} files in ${path.relative(process.cwd(), outputDirectory)} (seed ${seed}). Start with README.md.`
  );
} catch (error) {
  console.log(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

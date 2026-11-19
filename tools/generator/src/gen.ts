/**
 * Makes test workbooks of fake leads, one per source, in `output/workbooks/` of the generator.
 * The folder is made again on every run.
 *
 *   pnpm gen <number of leads> [--sources business_closure,new_acquisition,mutation]
 *
 * Without `--sources` every source is made. Send the workbooks with `pnpm send`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { generators, outputDirectory, outputFile, parseSources } from './sources';
import { generate, parseAmount, toWorkbook } from './workbooks';

try {
  const { values, positionals } = parseArgs({
    options: { sources: { type: 'string' } },
    allowPositionals: true,
  });
  const sources = parseSources(values.sources);
  const amount = parseAmount(positionals.at(-1));

  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  for (const source of sources) {
    writeFileSync(outputFile(source), toWorkbook(source, generate(amount, generators[source].generate)));
  }
} catch (error) {
  console.log(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

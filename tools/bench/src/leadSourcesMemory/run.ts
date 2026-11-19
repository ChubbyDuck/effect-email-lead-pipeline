/**
 * Manual benchmark: memory and time of one lead-sources handler on a large workbook.
 * Not a test. Nothing runs it except you:
 *
 *   pnpm bench:lead-sources-memory
 *   pnpm bench:lead-sources-memory --rows 50000 --source mutation --heaps unlimited,512,1024
 *
 * Options:
 *   --rows         rows in the workbook (default 100000)
 *   --source       business-closure | new-acquisition | mutation (default business-closure, the widest row)
 *   --heaps        V8 old-space limits in MiB, or `unlimited` (default unlimited,384,512,640,768,1024)
 *   --concurrency  batch sends at once (default burst simulator src_c)
 *   --runs         runs per heap limit (default 1)
 *
 * It makes a compressed workbook (cached), bundles `measure.ts` as the Lambda build does,
 * and starts plain `node` once per measurement, so each peak RSS belongs to one process.
 * Each run writes a Markdown log and appends JSON lines under `tools/bench/results/lead-sources-memory/`.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { handlerSettings } from '@leads/shared/domain/handlerSettings';
import { build } from 'vite';

import { makeWorkbook, type SourceName, sourceNames } from './workbook';

const benchDir = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(benchDir, 'results/lead-sources-memory');

const { values } = parseArgs({
  options: {
    rows: { type: 'string', default: '100000' },
    source: { type: 'string', default: 'business-closure' },
    heaps: { type: 'string', default: 'unlimited,384,512,640,768,1024' },
    concurrency: { type: 'string', default: String(handlerSettings.internalConcurrency.leadSources) },
    runs: { type: 'string', default: '1' },
  },
});
const rows = Number(values.rows);
const runs = Number(values.runs);
const concurrency = Number(values.concurrency);
const source = values.source as SourceName;
if (!sourceNames.includes(source)) throw new Error(`--source must be one of ${sourceNames.join(', ')}`);
const heaps = values.heaps.split(',').map((heap) => (heap === 'unlimited' ? null : Number(heap)));

/** The line of `measure.ts`: its mode, and a number for each measure. The baseline mode has fewer measures. */
type Measurement = { readonly mode: 'baseline' | 'full' } & Partial<
  Record<
    | 'fileMiB'
    | 'readMs'
    | 'rows'
    | 'leads'
    | 'rejections'
    | 'batches'
    | 'payloadMiB'
    | 'parseMs'
    | 'extractMs'
    | 'batchMs'
    | 'totalMs'
    | 'heapLimitMiB'
    | 'heapUsedMiB'
    | 'externalMiB'
    | 'peakRssMiB',
    number
  >
>;
type Row = { heap: number | null; run: number; ok: boolean; measurement?: Measurement; error?: string };

mkdirSync(outDir, { recursive: true });

const workbookFile = path.join(outDir, `workbook-${source}-${rows}.xlsx`);
if (!existsSync(workbookFile)) {
  console.log(`Making ${workbookFile} …`);
  writeFileSync(workbookFile, makeWorkbook(source, rows));
}

console.log('Bundling measure.ts …');
const bundleDir = path.join(outDir, 'bundle');
await build({
  configFile: false,
  root: benchDir,
  logLevel: 'warn',
  ssr: { target: 'node', noExternal: true },
  build: {
    ssr: path.join(import.meta.dirname, 'measure.ts'),
    target: 'node24',
    outDir: bundleDir,
    emptyOutDir: true,
    copyPublicDir: false,
    rolldownOptions: { output: { format: 'cjs', entryFileNames: 'measure.cjs', codeSplitting: false } },
  },
});
const bundle = path.join(bundleDir, 'measure.cjs');

function measure(mode: 'baseline' | 'full', heap: number | null): Omit<Row, 'heap' | 'run'> {
  const flags = heap === null ? [] : [`--max-old-space-size=${heap}`];
  const child = spawnSync(process.execPath, [...flags, bundle, mode, workbookFile, String(concurrency)], {
    encoding: 'utf8',
    maxBuffer: 16 * 2 ** 20,
  });
  const line = child.stdout.trim().split('\n').at(-1);
  if (child.status === 0 && line?.startsWith('{')) return { ok: true, measurement: JSON.parse(line) as Measurement };
  const fatal = child.stderr.split('\n').find((text) => text.includes('FATAL') || text.includes('Error'));
  return { ok: false, error: (fatal ?? `exit ${child.status ?? child.signal}`).trim() };
}

console.log('Measuring the baseline …');
const baseline = measure('baseline', null);
const results: Row[] = [];
for (const heap of heaps) {
  for (let run = 1; run <= runs; run++) {
    console.log(`Measuring heap ${heap ?? 'unlimited'}, run ${run}/${runs} …`);
    results.push({ heap, run, ...measure('full', heap) });
  }
}

const at = new Date().toISOString();
const environment = {
  at,
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  memoryGiB: Math.round(totalmem() / 2 ** 30),
  source,
  rows,
  concurrency,
};
const first = results.find((row) => row.ok)?.measurement;
const cell = (value: number | undefined) => (value === undefined ? '' : String(value));
const table = [
  '| Heap limit MiB | Run | Result | Peak RSS MiB | Heap used MiB | External MiB | Parse ms | Extract ms | Batch ms | Total ms |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...results
    .map(({ heap, run, ok, measurement: m, error }) =>
      [
        heap ?? 'unlimited',
        run,
        ok ? 'ok' : `failed: ${error}`,
        cell(m?.peakRssMiB),
        cell(m?.heapUsedMiB),
        cell(m?.externalMiB),
        cell(m?.parseMs),
        cell(m?.extractMs),
        cell(m?.batchMs),
        cell(m?.totalMs),
      ].join(' | ')
    )
    .map((line) => `| ${line} |`),
].join('\n');
const passing = results.filter((row) => row.ok).map((row) => row.measurement?.peakRssMiB ?? 0);
const log = [
  `# Lead-sources memory benchmark, ${at}`,
  '',
  `- Node ${environment.node} on ${environment.platform}, ${environment.cpu}, ${environment.memoryGiB} GiB`,
  `- Workbook: ${source}, ${rows.toLocaleString('en-US')} rows, ${cell(first?.fileMiB)} MiB (\`${path.basename(workbookFile)}\`)`,
  `- Leads: ${cell(first?.leads)}, rejections: ${cell(first?.rejections)}, batches: ${cell(first?.batches)}, payload: ${cell(first?.payloadMiB)} MiB`,
  `- Batch sends at once: ${concurrency}`,
  `- Baseline (code loaded, file read): ${baseline.ok ? `${cell(baseline.measurement?.peakRssMiB)} MiB peak RSS` : `failed: ${baseline.error}`}`,
  `- Largest peak RSS of a run that passed: ${passing.length > 0 ? `${Math.max(...passing)} MiB` : 'none passed'}`,
  '',
  table,
  '',
].join('\n');

const logFile = path.join(outDir, `${at.replaceAll(':', '-')}.md`);
writeFileSync(logFile, log);
appendFileSync(
  path.join(outDir, 'results.jsonl'),
  results.map((row) => JSON.stringify({ ...environment, baseline: baseline.measurement, ...row })).join('\n') + '\n'
);
console.log(`\n${log}`);
console.log(`Log: ${path.relative(benchDir, logFile)}`);

/**
 * The measured program: the lead-sources handler work without the network.
 * `run.ts` bundles this file and starts it with plain `node`, one process per measurement.
 *
 *   node measure.cjs baseline <workbook>
 *   node measure.cjs full <workbook> <batch sends at once>
 *
 * Prints one JSON line. `peakRssMiB` is the peak resident set size of this process.
 */
import { readFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';

import { SQSClient } from '@aws-sdk/client-sqs';
import { toLeadsAndRejectionsFromSheet } from '@leads/pipeline/domain/Transformations/leadSources';
import { ExcelSheetParserLive } from '@leads/pipeline/infrastructure/ExcelSheetParser/live';
import { ExcelSheetParser } from '@leads/pipeline/ports/ExcelSheetParser';
import { QueueBatchSize } from '@leads/shared/domain/queueLimits';
import { Array as Arr, Effect } from 'effect';

const [mode, file, concurrencyArgument] = process.argv.slice(2);
if ((mode !== 'baseline' && mode !== 'full') || file === undefined) {
  throw new Error('Usage: measure.cjs baseline|full <workbook> [concurrency]');
}
const concurrency = Number(concurrencyArgument ?? 1);
const mib = (bytes: number) => Math.round((bytes / 2 ** 20) * 10) / 10;
// The Lambda loads the SDK client before the first invocation, so the baseline holds it too.
new SQSClient({});

const started = performance.now();
const body = readFileSync(file);
const read = performance.now();

const program = Effect.gen(function* () {
  if (mode === 'baseline') return {};
  const parser = yield* ExcelSheetParser;
  const sheet = yield* parser.parse(body);
  const parsed = performance.now();
  const { leads, leadRejections } = yield* toLeadsAndRejectionsFromSheet(sheet);
  const extracted = performance.now();
  const batches = Arr.chunksOf(
    leads.map((lead) => ({ lead, requestID: '12345678-1234-4234-8234-123456789abc' })),
    QueueBatchSize
  );
  let payloadBytes = 0;
  // Builds each SendMessageBatch payload, `concurrency` batches at once, as `Queue.pushBatch` does.
  yield* Effect.forEach(
    batches,
    (messages) =>
      Effect.sync(() => {
        const entries = messages.map((message, index) => ({ Id: String(index), MessageBody: JSON.stringify(message) }));
        payloadBytes += Buffer.byteLength(JSON.stringify(entries));
      }).pipe(Effect.andThen(Effect.yieldNow)),
    { concurrency, discard: true }
  );
  const batched = performance.now();
  return {
    rows: sheet.rows.length,
    leads: leads.length,
    rejections: leadRejections.length,
    batches: batches.length,
    payloadMiB: mib(payloadBytes),
    parseMs: Math.round(parsed - read),
    extractMs: Math.round(extracted - parsed),
    batchMs: Math.round(batched - extracted),
  };
});

async function main() {
  const result = await Effect.runPromise(program.pipe(Effect.provide(ExcelSheetParserLive)));
  const heap = getHeapStatistics();
  console.log(
    JSON.stringify({
      mode,
      fileMiB: mib(body.length),
      readMs: Math.round(read - started),
      ...result,
      totalMs: Math.round(performance.now() - started),
      heapLimitMiB: mib(heap.heap_size_limit),
      heapUsedMiB: mib(heap.used_heap_size),
      externalMiB: mib(process.memoryUsage().external),
      // libuv reports maxRSS in KiB on every platform.
      peakRssMiB: mib(process.resourceUsage().maxRSS * 1024),
    })
  );
}

void main();

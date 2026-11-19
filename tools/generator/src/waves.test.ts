import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Clock, Effect, Exit, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, test } from 'vitest';

import { FolderNotRead, Mailer, readWaves, sendWaves, WaveNotSent, type Wave, type WaveEmail } from './waves';

const waves = (count: number): Wave[] =>
  Array.from({ length: count }, (_, index) => ({
    filename: `wave-${index + 1}.xlsx`,
    content: Buffer.from(`file ${index + 1}`),
  }));

/** A mailer that records each email with its time on the Effect clock. Each send takes `time`, and `onSend` can fail it. */
function recorder({
  time = '0 millis',
  onSend = () => Effect.void,
}: {
  readonly time?: `${number} ${'millis' | 'seconds'}`;
  readonly onSend?: (email: WaveEmail) => Effect.Effect<void, WaveNotSent>;
} = {}) {
  const sent: { readonly at: number; readonly email: WaveEmail }[] = [];
  const layer = Layer.succeed(Mailer, {
    send: (email) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((at) => {
          sent.push({ at, email });
          return Effect.sleep(time);
        }),
        Effect.andThen(onSend(email))
      ),
  });
  return { sent, layer };
}

const run = <A, E>(effect: Effect.Effect<A, E, Mailer>, mailer: Layer.Layer<Mailer>) =>
  Effect.runPromise(effect.pipe(Effect.provide([mailer, TestClock.layer()])));

test('sends the first wave at once, and each next wave one interval later', async () => {
  const { sent, layer } = recorder();

  await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(sendWaves(waves(3), '60 seconds'));
      yield* TestClock.adjust('59 seconds');
      expect(sent.map(({ at }) => at)).toEqual([0]);
      yield* TestClock.adjust('1 seconds');
      expect(sent.map(({ at }) => at)).toEqual([0, 60_000]);
      yield* TestClock.adjust('60 seconds');
      yield* Fiber.join(fiber);
    }),
    layer
  );

  expect(sent.map(({ at }) => at)).toEqual([0, 60_000, 120_000]);
});

test('keeps one interval from start to start when a send takes time', async () => {
  const { sent, layer } = recorder({ time: '5 seconds' });

  await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(sendWaves(waves(3), '60 seconds'));
      yield* TestClock.adjust('125 seconds');
      yield* Fiber.join(fiber);
    }),
    layer
  );

  expect(sent.map(({ at }) => at)).toEqual([0, 60_000, 120_000]);
});

test('sends the next wave at once when a send takes longer than the interval', async () => {
  const { sent, layer } = recorder({ time: '70 seconds' });

  await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(sendWaves(waves(2), '60 seconds'));
      yield* TestClock.adjust('140 seconds');
      yield* Fiber.join(fiber);
    }),
    layer
  );

  expect(sent.map(({ at }) => at)).toEqual([0, 70_000]);
});

test('gives each email its file and its place in the waves', async () => {
  const { sent, layer } = recorder();
  const files = waves(2);

  await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(sendWaves(files, '1 seconds'));
      yield* TestClock.adjust('1 seconds');
      yield* Fiber.join(fiber);
    }),
    layer
  );

  expect(sent.map(({ email }) => email)).toEqual([
    { ...files[0], subject: 'Leads wave 1 of 2' },
    { ...files[1], subject: 'Leads wave 2 of 2' },
  ]);
});

test('stops at the first failure, so that no later wave goes out', async () => {
  const reason = new Error('Connection lost');
  const failure = new WaveNotSent({ filename: 'wave-2.xlsx', reason });
  const { sent, layer } = recorder({
    onSend: ({ filename }) => (filename === failure.filename ? Effect.fail(failure) : Effect.void),
  });

  const exit = await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(sendWaves(waves(3), '60 seconds').pipe(Effect.exit));
      yield* TestClock.adjust('180 seconds');
      return yield* Fiber.join(fiber);
    }),
    layer
  );

  expect(sent.map(({ email }) => email.filename)).toEqual(['wave-1.xlsx', 'wave-2.xlsx']);
  expect(Exit.isFailure(exit)).toBe(true);
  expect(failure.message).toBe('wave-2.xlsx was not sent due to: Connection lost');
  expect(failure.reason).toBe(reason);
});

test('reads the files of a folder in the order of their names, without the hidden files', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'waves-'));
  try {
    await Promise.all(
      ['10-last.xlsx', '2-second.xlsx', '1-first.xlsx', '.DS_Store'].map((name) =>
        writeFile(path.join(folder, name), name)
      )
    );

    const read = await Effect.runPromise(readWaves(folder));

    expect(read.map(({ filename }) => filename)).toEqual(['1-first.xlsx', '2-second.xlsx', '10-last.xlsx']);
    expect(read[0]?.content.toString()).toBe('1-first.xlsx');
  } finally {
    await rm(folder, { recursive: true });
  }
});

test('a folder that cannot be read fails with FolderNotRead, which keeps the original failure', async () => {
  const folder = path.join(tmpdir(), 'waves-that-do-not-exist');

  const error = await Effect.runPromise(Effect.flip(readWaves(folder)));

  expect(error).toBeInstanceOf(FolderNotRead);
  expect(error.folder).toBe(folder);
  expect(error.reason).toMatchObject({ code: 'ENOENT' });
  expect(error.message).toBe(`Cannot read the folder ${folder}: ${String(error.reason)}`);
});

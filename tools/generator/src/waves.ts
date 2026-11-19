import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { Clock, Context, Data, Duration, Effect } from 'effect';

/** One file to send. Each file goes out as one email with one attachment. */
export interface Wave {
  readonly filename: string;
  readonly content: Buffer;
}

export interface WaveEmail extends Wave {
  readonly subject: string;
}

export class WaveNotSent extends Data.TaggedError('WaveNotSent')<{
  readonly filename: string;
  readonly reason: unknown;
}> {
  override get message(): string {
    const reason = this.reason instanceof Error ? ` due to: ${this.reason.message}` : '';
    return `${this.filename} was not sent${reason}`;
  }
}

/** The folder of the waves, or a file in it, cannot be read. */
export class FolderNotRead extends Data.TaggedError('FolderNotRead')<{
  readonly folder: string;
  readonly reason: unknown;
}> {
  override get message(): string {
    return `Cannot read the folder ${this.folder}: ${String(this.reason)}`;
  }
}

/** The files of `folder`, in the order of their names, without the hidden files. Each file is one wave. */
export const readWaves = (folder: string): Effect.Effect<Wave[], FolderNotRead> =>
  Effect.tryPromise({
    try: async () => {
      const names = (await readdir(folder))
        .filter((name) => !name.startsWith('.'))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return Promise.all(
        names.map(async (filename) => ({ filename, content: await readFile(path.join(folder, filename)) }))
      );
    },
    catch: (reason) => new FolderNotRead({ folder, reason }),
  });

export class Mailer extends Context.Service<
  Mailer,
  { readonly send: (email: WaveEmail) => Effect.Effect<void, WaveNotSent> }
>()('@leads/generator/waves/Mailer') {}

/**
 * Sends one email for each wave, one after another. Each wave starts `every` after the start of the previous one, so the
 * time of a send does not change the rate. A wave that is late goes out at once. The first failure stops the loop, so
 * that the waves after it stay unsent and can go out again.
 */
export const sendWaves = (waves: readonly Wave[], every: Duration.Input) =>
  Effect.gen(function* () {
    const mailer = yield* Mailer;
    const interval = Duration.toMillis(every);
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      waves,
      (wave, index) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.sleep(Duration.millis(Math.max(0, startedAt + index * interval - now)))),
          Effect.andThen(mailer.send({ ...wave, subject: `Leads wave ${index + 1} of ${waves.length}` }))
        ),
      { discard: true }
    );
  });

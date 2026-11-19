import type { File } from '@leads/shared/domain/types';
import { Context, Data, type Effect } from 'effect';

const withReason = (message: string, reason: unknown) =>
  reason instanceof Error ? `${message} due to: ${reason.message}` : message;

export class FileNotStored extends Data.TaggedError('FileNotStored')<{
  readonly file: File;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`File was not stored in a bucket: ${this.file.bucket} with key: ${this.file.key}`, this.reason);
  }
}

export class FileNotDeleted extends Data.TaggedError('FileNotDeleted')<{
  readonly file: File;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`File not deleted from bucket: ${this.file.bucket} with key: ${this.file.key}`, this.reason);
  }
}

export class FileNotRead extends Data.TaggedError('FileNotRead')<{
  readonly bucket: string;
  readonly key: string;
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason(`File could not be read from bucket: ${this.bucket} with key: ${this.key}`, this.reason);
  }
}

/** `skipped` means that the key already had a file, which `storeOrSkip` did not change. */
export type StoreOrSkipResult = 'stored' | 'skipped';

export class Storage extends Context.Service<
  Storage,
  {
    readonly store: (file: File) => Effect.Effect<void, FileNotStored>;
    readonly storeSafe: (file: File) => Effect.Effect<void>;
    readonly delete: (bucket: string, key: string) => Effect.Effect<void, FileNotDeleted>;
    readonly read: (bucket: string, key: string) => Effect.Effect<File, FileNotRead>;
    /** Stores the file only if its key is empty, so a second store of the same key sends no new S3 event. */
    readonly storeOrSkip: (file: File) => Effect.Effect<StoreOrSkipResult, FileNotStored>;
  }
>()('@leads/pipeline/Core/Pipeline/Ports/Storage') {}

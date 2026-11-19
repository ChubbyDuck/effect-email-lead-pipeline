import { Data } from 'effect';

export class FileIsEmpty extends Data.TaggedError('File is empty')<{
  readonly service: string;
  readonly reason: unknown;
}> {
  override get message(): string {
    return `File is empty in ${this.service}`;
  }
}

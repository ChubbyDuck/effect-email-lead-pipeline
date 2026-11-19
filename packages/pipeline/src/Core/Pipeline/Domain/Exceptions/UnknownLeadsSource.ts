import { Data } from 'effect';

export class UnknownLeadsSource extends Data.TaggedError('UnknownLeadsSource')<{
  readonly header: ReadonlyArray<string>;
}> {
  override readonly message = 'Unknown leads source';
}

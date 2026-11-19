import type { Email, File } from '@leads/shared/domain/types';
import { withReason } from '@leads/shared/utils';
import { Context, Data, type Effect } from 'effect';

export class EmailNotParsed extends Data.TaggedError('EmailNotParsed')<{
  readonly reason: unknown;
}> {
  override get message(): string {
    return withReason('Email cannot be parsed', this.reason);
  }
}

export class EmailParser extends Context.Service<
  EmailParser,
  {
    readonly parse: (file: File) => Effect.Effect<Email, EmailNotParsed>;
  }
>()('@leads/pipeline/Core/Pipeline/Ports/EmailParser') {}

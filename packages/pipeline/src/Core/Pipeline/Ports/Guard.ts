import type { Email } from '@leads/shared/domain/types';
import { Config, Context, Data, type Effect, Schema } from 'effect';

export const SenderAddress = Schema.String.check(Schema.isPattern(/^\s*[^@\s]+@[^@\s]+\s*$/));

/** The only senders that the inbox accepts. It has no default: the deployment must name them. */
export const InboxSenderWhitelist = Config.Array(SenderAddress, 'INBOX_SENDER_WHITELIST');

const withReason = (message: string, reason: unknown) =>
  reason instanceof Error ? `${message} due to: ${reason.message}` : message;

export class Unauthorized extends Data.TaggedError('Unauthorized')<{
  readonly senders: Email['senders'];
  readonly reason: unknown;
}> {
  override get message(): string {
    const listed = this.senders.length > 0 ? this.senders.join(', ') : 'none';
    return withReason(`Unauthorized senders: ${listed}`, this.reason);
  }
}

export class Guard extends Context.Service<
  Guard,
  {
    /** Authorizes the senders of the email only when SES proves that its single From header is real. */
    readonly authorize: (email: Email) => Effect.Effect<void, Unauthorized>;
  }
>()('@leads/pipeline/Core/Pipeline/Ports/Guard') {}

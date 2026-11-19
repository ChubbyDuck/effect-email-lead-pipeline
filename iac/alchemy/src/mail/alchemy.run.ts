import * as AWS from '@alchemy.run/aws';
import { mailNames } from '@leads/shared/names';
import * as Alchemy from 'alchemy';
import * as Data from 'effect/Data';
import * as Effect from 'effect/Effect';

import { leadsMail } from '#mail/stack';

/** Thrown when the mail stack is deployed to a stage that is not `mail`. */
export class NotTheMailStage extends Data.TaggedError('NotTheMailStage')<{ readonly stage: string }> {
  override get message(): string {
    return `The mail stack has the one stage ${mailNames.stage}, not ${this.stage}`;
  }
}

/**
 * The mail stack of the account (`leadsMail`), in the AWS project only. It signs in with the Alchemy profile of the
 * README and keeps its state in AWS, as `production-alchemy` does:
 * `alchemy deploy src/mail/alchemy.run.ts --stage mail --profile <the AWS profile>`. Run it with `pnpm infra:mail:deploy`.
 */
export default Alchemy.Stack(
  mailNames.stack,
  { providers: AWS.providers(), state: AWS.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (stage !== mailNames.stage) return yield* Effect.die(new NotTheMailStage({ stage }));
    yield* leadsMail;
  })
);

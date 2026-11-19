import { definePortMock } from '@leads/shared/testing/variants';
import { Effect } from 'effect';

import { Guard, Unauthorized } from '#Core/Pipeline/Ports/Guard';

const guardMock = definePortMock(Guard, ({ method, record, observation }) => {
  const authorize = record('authorize');

  return {
    variants: {
      authorize: method('authorize', {
        failsWithUnauthorized: (email) =>
          authorize(email).pipe(
            Effect.andThen(Effect.fail(new Unauthorized({ senders: email.senders, reason: 'unavailable' })))
          ),
        succeeds: authorize,
      }),
    },
    observation,
  };
});

export const guardBuilder = guardMock.builder;
export const makeGuard = guardMock.make;

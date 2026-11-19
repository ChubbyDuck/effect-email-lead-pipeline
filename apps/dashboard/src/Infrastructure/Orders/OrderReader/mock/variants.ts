import { definePortMock } from '@leads/shared/testing/variants';
import { Effect } from 'effect';

import type { OrderRead } from '#Core/Orders/Domain/order';
import { OrderReader, OrdersNotRead } from '#Core/Orders/Ports/OrderReader';

export const readFailure = new Error('unavailable');
export const sessionExpired = Object.assign(new Error('The security token included in the request is expired'), {
  name: 'ExpiredTokenException',
});

const orderReaderMock = definePortMock(OrderReader, ({ method, record, observation }) => {
  const all = record('all');
  let read: OrderRead = { orders: [], readAt: new Date(0).toISOString() };

  return {
    variants: {
      all: method('all', {
        failsWithOrdersNotRead: all().pipe(
          Effect.andThen(Effect.fail(new OrdersNotRead({ reason: readFailure, authentication: false })))
        ),
        failsWithOrdersNotReadForExpiredSession: all().pipe(
          Effect.andThen(Effect.fail(new OrdersNotRead({ reason: sessionExpired, authentication: true })))
        ),
        /** Gives the orders that the test set with `holds`, at the time of each read. */
        succeeds: all().pipe(Effect.andThen(Effect.sync(() => read))),
      }),
    },
    observation: {
      get calls() {
        return observation.calls;
      },
      /** Sets the orders that the next reads give. */
      holds(next: OrderRead) {
        read = next;
      },
    },
  };
});

export const orderReaderBuilder = orderReaderMock.builder;
export const makeOrderReader = orderReaderMock.make;

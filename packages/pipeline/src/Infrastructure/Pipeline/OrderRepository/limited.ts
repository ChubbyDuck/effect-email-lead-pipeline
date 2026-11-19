import { orderWritesPerSecond } from '@leads/shared/domain/orderWrites';
import { Effect, Layer } from 'effect';
import type { RateLimiter } from 'effect/persistence';

import { OrderRepository, OrderStoreFailed } from '#Core/Pipeline/Ports/OrderRepository';

/**
 * Wraps an order repository so that each store first takes one token of the order write limit from `limiter`. A store
 * over the limit waits for its token and does not fail. The limiter must live as long as the execution environment,
 * so that its bucket holds from one invocation to the next.
 */
export const withOrderWriteLimit =
  (limiter: RateLimiter.RateLimiter) =>
  <E, R>(repository: Layer.Layer<OrderRepository, E, R>) =>
    Layer.effect(
      OrderRepository,
      Effect.gen(function* () {
        const orders = yield* OrderRepository;
        const take = limiter
          .consume({
            key: 'order-writes',
            algorithm: 'token-bucket',
            onExceeded: 'delay',
            window: '1 second',
            limit: orderWritesPerSecond.environment,
          })
          .pipe(
            Effect.flatMap(({ delay }) => Effect.sleep(delay)),
            Effect.mapError((reason) => new OrderStoreFailed({ reason }))
          );

        return {
          store: (lead) => take.pipe(Effect.andThen(orders.store(lead))),
        };
      })
    ).pipe(Layer.provide(repository));

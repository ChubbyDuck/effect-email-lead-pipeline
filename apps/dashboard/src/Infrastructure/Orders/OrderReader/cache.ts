import { Clock, Duration, Effect, Ref } from 'effect';

import type { OrderRead } from '#Core/Orders/Domain/order';
import { OrderReader } from '#Core/Orders/Ports/OrderReader';

/**
 * Keeps the last read of the orders for a short time, so that the requests of one person share one scan. A read that
 * failed is not kept, so the next request reads again. `fresh` always reads, and its read replaces the kept one.
 */
export const makeOrderCache = (reader: typeof OrderReader.Service, keep: Duration.Input) =>
  Effect.gen(function* () {
    const keepMillis = Duration.toMillis(Duration.fromInputUnsafe(keep));
    const kept = yield* Ref.make<{ readonly at: number; readonly read: OrderRead } | undefined>(undefined);

    const fresh = Effect.gen(function* () {
      const read = yield* reader.all;
      yield* Ref.set(kept, { at: yield* Clock.currentTimeMillis, read });
      return read;
    });

    const cached = Effect.gen(function* () {
      const last = yield* Ref.get(kept);
      const now = yield* Clock.currentTimeMillis;
      if (last !== undefined && now - last.at < keepMillis) return last.read;
      return yield* fresh;
    });

    return { cached: OrderReader.of({ all: cached }), fresh: OrderReader.of({ all: fresh }) };
  });

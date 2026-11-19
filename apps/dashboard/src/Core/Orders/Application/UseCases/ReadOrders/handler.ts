import { Effect } from 'effect';

import { orderPageOf } from '#Core/Orders/Domain/order';
import { defaultOrderQuery } from '#Core/Orders/Domain/orderQuery';
import { OrderReader } from '#Core/Orders/Ports/OrderReader';

import type { Command } from './command';

/** Reads all the orders, and gives the page of the query. The total and the counts come from the same read. */
export function handler(command: Command = defaultOrderQuery) {
  return Effect.gen(function* () {
    const orderReader = yield* OrderReader;
    const read = yield* orderReader.all;
    return orderPageOf(read, command);
  });
}

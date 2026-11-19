import { createServerFn } from '@tanstack/react-start';
import { Cause, Exit } from 'effect';

import type { OrderPage } from '#Core/Orders/Domain/order';
import { type OrderQuery, toOrderQuery } from '#Core/Orders/Domain/orderQuery';
import { OrdersNotRead } from '#Core/Orders/Ports/OrderReader';

import { dashboardServices } from './services.server';

/** One page of the orders, or why the read failed. `authentication` says that a new AWS sign-in fixes the read. */
export type OrdersResult =
  | { readonly ok: true; readonly page: OrderPage }
  | { readonly ok: false; readonly error: string; readonly authentication: boolean };

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The raw input: `fresh` and each part of the order query, none of them validated yet. */
type Input = { readonly fresh?: unknown } & { readonly [Key in keyof OrderQuery]?: unknown };

/** The input of the read. A value of the query that is not valid falls back as `toOrderQuery` says. */
const toInput = (input: Input | undefined) => ({
  fresh: input?.fresh === true,
  query: toOrderQuery(input ?? {}),
});

/**
 * The HTTP adapter that reads one page of the orders. It only reads. Requests in a short time share one scan of the
 * table, and `fresh` skips that cache, so that the refresh button shows the new orders.
 */
export const readOrders = createServerFn({ method: 'GET' })
  .validator(toInput)
  .handler(async ({ data }): Promise<OrdersResult> => {
    try {
      const exit = await dashboardServices().orderPage(data.query, data.fresh);
      if (Exit.isSuccess(exit)) return { ok: true, page: exit.value };
      const error = Cause.squash(exit.cause);
      return {
        ok: false,
        error: messageOf(error),
        authentication: error instanceof OrdersNotRead && error.authentication,
      };
    } catch (error) {
      return { ok: false, error: messageOf(error), authentication: false };
    }
  });

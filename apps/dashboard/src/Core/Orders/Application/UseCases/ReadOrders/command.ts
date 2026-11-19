import type { OrderQuery } from '#Core/Orders/Domain/orderQuery';

/** The order query of the dashboard: which orders to read, how to sort them, and which page of them to give. */
export type Command = OrderQuery;

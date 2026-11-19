/** Lambda timeouts of the stack, in ms. `iac/cdk/src/stack.test.ts` checks them against the deployed functions. */
export const handlerTimeouts = { inbox: 60_000, source: 300_000, lead: 60_000 };

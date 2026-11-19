const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export type LambdaDeadline = {
  readonly getRemainingTimeInMillis: () => number;
};

export type LambdaShutdown = {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
};

// Effect.runPromise interrupts the fiber when this signal aborts. The invocation
// deadline covers the native timeout. SIGTERM and SIGINT cover a runtime shutdown.
export function bindLambdaShutdown(context: LambdaDeadline): LambdaShutdown {
  const controller = new AbortController();
  const abort = () => {
    controller.abort();
  };

  for (const name of SHUTDOWN_SIGNALS) {
    process.once(name, abort);
  }

  const timer = setTimeout(abort, Math.max(0, context.getRemainingTimeInMillis()));

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      for (const name of SHUTDOWN_SIGNALS) {
        process.off(name, abort);
      }
    },
  };
}

export async function withLambdaShutdown<A>(
  context: LambdaDeadline,
  run: (signal: AbortSignal) => Promise<A>
): Promise<A> {
  const shutdown = bindLambdaShutdown(context);
  try {
    return await run(shutdown.signal);
  } finally {
    shutdown.dispose();
  }
}

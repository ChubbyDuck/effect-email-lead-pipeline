import { handler as watchRequests } from '#Core/Observation/Application/UseCases/WatchRequests/handler';
import type { FeedEvent } from '#Core/Observation/Domain/requests';

import { labServices, requestPollMs } from './services.server';

/**
 * The live request ledger, as a stream of server-sent events. The stream sends every entry that the feed holds, and
 * after that only the entries that changed. It stops when the page aborts `request`.
 */
export function streamRequests(request: Request): Response {
  const services = labServices();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | undefined;
  let closed = false;
  /** The page closed the stream. The feed stops when no page listens. */
  const stop = () => {
    closed = true;
    unsubscribe?.();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        if (!closed) controller.enqueue(encoder.encode(text));
      };
      write(`retry: ${requestPollMs}\n\n`);
      unsubscribe = watchRequests(services, {
        listener: (event: FeedEvent) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
      });
      request.signal.addEventListener(
        'abort',
        () => {
          if (closed) return;
          stop();
          controller.close();
        },
        { once: true }
      );
    },
    cancel: stop,
  });

  return new Response(body, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
  });
}

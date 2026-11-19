import { createFileRoute } from '@tanstack/react-router';

import { streamRequests } from '#Entrypoints/Lab/requests.server';

/** The live request ledger, as a stream of server-sent events. The body is an entry point of the core. */
export const Route = createFileRoute('/api/requests')({
  server: {
    handlers: {
      GET: ({ request }) => streamRequests(request),
    },
  },
});

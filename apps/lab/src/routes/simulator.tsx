import { createFileRoute } from '@tanstack/react-router';

import { comparisonLimit, requestIDsOf, type RequestRead } from '#Core/Observation/Domain/comparison';
import { readComparisons } from '#Entrypoints/Lab/comparison';

import { SimulatorApp } from '../UI/Simulator/App';

const failure =
  (requestIDs: readonly string[]) =>
  (error: unknown): readonly RequestRead[] => {
    const message = error instanceof Error ? error.message : String(error);
    return requestIDs.map((requestID) => ({ requestID, result: { ok: false, error: message } }));
  };

const requestsOf = (requests: string | undefined) => requestIDsOf(requests ?? '').slice(0, comparisonLimit);

/**
 * The burst simulator: one simulated burst through the pipeline, next to the lab of the real one. With `requests`,
 * a list with commas, the page reads those requests and draws their real runs with the model.
 */
export const Route = createFileRoute('/simulator')({
  validateSearch: (search: Record<string, unknown>): { readonly requests?: string } => {
    // `request` is the old form of a link. A saved link to one request still opens that request.
    const list = search.requests ?? search.request;
    const requests = typeof list === 'string' ? requestsOf(list).join(',') : '';
    return requests === '' ? {} : { requests };
  },
  loaderDeps: ({ search }) => ({ requests: search.requests }),
  // The loader does not wait for the read, so that the model shows at once.
  loader: ({ deps }) => {
    const requestIDs = requestsOf(deps.requests);
    return {
      comparison:
        requestIDs.length === 0 ? undefined : readComparisons({ data: { requestIDs } }).catch(failure(requestIDs)),
    };
  },
  head: () => ({
    meta: [
      { title: 'Leads · Burst simulator' },
      {
        name: 'description',
        content: 'Explore the leads pipeline: fan-out, concurrency, cohort timing, and event cost.',
      },
    ],
  }),
  component: Simulator,
});

function Simulator() {
  const { requests } = Route.useSearch();
  const { comparison } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  return (
    <SimulatorApp
      requests={requestsOf(requests)}
      comparison={comparison}
      onRequests={(requestIDs) =>
        navigate({ search: requestIDs.length === 0 ? {} : { requests: requestIDs.join(',') } })
      }
    />
  );
}

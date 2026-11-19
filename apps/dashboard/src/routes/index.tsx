import { Alert, AlertDescription, AlertTitle } from '@leads/ui/components/alert';
import { Button } from '@leads/ui/components/button';
import { Card } from '@leads/ui/components/card';
import { cn } from '@leads/ui/lib/utils';
import { createFileRoute, stripSearchParams, useRouter } from '@tanstack/react-router';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { type ReactNode, Suspense, use, useDeferredValue } from 'react';

import { defaultOrderFilter, type OrderTypeFilter } from '#Core/Orders/Domain/orderFilter';
import { defaultOrderPaging, type OrderPageSize } from '#Core/Orders/Domain/orderPaging';
import { changeOrderQuery, type OrderQuery, toOrderQuery } from '#Core/Orders/Domain/orderQuery';
import { nextOrderSort, type OrderSortKey } from '#Core/Orders/Domain/orderSort';
import { readOrders, type OrdersResult } from '#Entrypoints/Dashboard/orders';

import { fmt, time } from '../UI/format';
import { OrderFilters } from '../UI/OrderFilters';
import { OrderPagination } from '../UI/OrderPagination';
import { OrderSheet } from '../UI/OrderSheet';
import { OrdersTable } from '../UI/OrdersTable';
import { useSearchText } from '../UI/useSearchText';

const failure = (error: unknown): OrdersResult => ({
  ok: false,
  error: error instanceof Error ? error.message : String(error),
  authentication: false,
});

/** The refresh button sets this flag, so that the next load skips the cache of the server. */
let freshRead = false;

export const Route = createFileRoute('/')({
  // The state of the page is the order query in the URL. A value that is not valid falls back to its default.
  validateSearch: (search: Record<string, unknown>): OrderQuery => toOrderQuery(search),
  // No filter, the first page, and the default size are the defaults, so the URL leaves them out.
  search: { middlewares: [stripSearchParams({ ...defaultOrderFilter, ...defaultOrderPaging })] },
  loaderDeps: ({ search }) => search,
  // The loader does not wait for the read, so that the page shows at once with placeholder rows.
  loader: ({ deps }) => {
    const fresh = freshRead;
    freshRead = false;
    return { orders: readOrders({ data: { fresh, ...deps } }).catch(failure) };
  },
  component: Orders,
});

/**
 * The orders that the lead handler stored, newest first by default. A click on the header of a column sorts them by
 * it. A search text and a source type narrow them. The buttons below the table go through them in pages. A click on a
 * row opens the order in a sheet, and the `order` key in the URL keeps it open.
 */
function Orders() {
  const search = Route.useSearch();
  const { orders } = Route.useLoaderData();
  // While a new read loads, the page keeps the last one.
  const shown = useDeferredValue(orders);
  const router = useRouter();
  const navigate = Route.useNavigate();
  /** A change of the query is a navigation, so that the back button undoes it. */
  const change = (part: Partial<OrderQuery>) =>
    void navigate({ search: (previous) => changeOrderQuery(previous, part) });
  const searchText = useSearchText(search.q, (q) => change({ q }));

  const page = (result: OrdersResult | undefined) => (
    <Page
      result={result}
      search={search}
      text={searchText.text}
      onText={searchText.change}
      onType={(type) => change({ type })}
      onClear={() => {
        searchText.reset();
        change(defaultOrderFilter);
      }}
      onSort={(key) => change(nextOrderSort(search, key))}
      onPage={(page) => change({ page })}
      onSize={(size) => change({ size })}
      onOpen={(order) => change({ order })}
      onClose={() => change({ order: undefined })}
      loading={result === undefined || shown !== orders}
      onRefresh={() => {
        freshRead = true;
        void router.invalidate();
      }}
    />
  );

  return (
    <Suspense fallback={page(undefined)}>
      <Settled promise={shown}>{page}</Settled>
    </Suspense>
  );
}

function Settled<T>({
  promise,
  children,
}: {
  readonly promise: Promise<T>;
  readonly children: (value: T) => ReactNode;
}) {
  return children(use(promise));
}

function Page({
  result,
  search,
  text,
  loading,
  onText,
  onType,
  onClear,
  onSort,
  onPage,
  onSize,
  onOpen,
  onClose,
  onRefresh,
}: {
  /** No result while the first read loads. */
  readonly result: OrdersResult | undefined;
  readonly search: OrderQuery;
  /** The text of the search field, which reaches the URL after a short pause. */
  readonly text: string;
  readonly loading: boolean;
  readonly onText: (text: string) => void;
  readonly onType: (type: OrderTypeFilter) => void;
  readonly onClear: () => void;
  readonly onSort: (key: OrderSortKey) => void;
  readonly onPage: (page: number) => void;
  readonly onSize: (size: OrderPageSize) => void;
  readonly onOpen: (key: string) => void;
  readonly onClose: () => void;
  readonly onRefresh: () => void;
}) {
  const page = result?.ok === true ? result.page : undefined;
  return (
    <main className="mx-auto flex max-w-[1320px] flex-col gap-6 px-4 py-6 md:px-6 md:py-7">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div>
          <h1 className="text-[26px] leading-tight font-extrabold tracking-tight">Orders</h1>
          <p className="mt-0.5 min-h-5 text-muted-foreground">
            {page !== undefined && (
              <>
                {page.total !== page.storedTotal && `${fmt(page.total)} of `}
                {fmt(page.storedTotal)} {page.storedTotal === 1 ? 'order' : 'orders'} ·{' '}
                <span title={page.readAt}>read at {time(page.readAt)}</span>
              </>
            )}
          </p>
        </div>
        <Button
          className="ml-auto h-10 rounded-[10px] bg-foreground px-4 font-bold text-background hover:bg-foreground/85"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={cn(loading && 'animate-spin motion-reduce:animate-none')} />
          Refresh
        </Button>
      </header>
      <OrderFilters
        text={text}
        type={search.type}
        counts={page?.counts}
        onText={onText}
        onType={onType}
        onClear={onClear}
      />
      {result?.ok === false ? (
        <Problem title="Cannot read the orders">
          {result.authentication ? (
            <p>The AWS session expired. Sign in to AWS again and refresh.</p>
          ) : (
            <p>{result.error}</p>
          )}
        </Problem>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          <OrdersTable
            rows={page?.rows}
            storedTotal={page?.storedTotal}
            sort={search}
            openKey={search.order}
            onSort={onSort}
            onOpen={onOpen}
            onClear={onClear}
          />
          <OrderPagination orderPage={page} size={search.size} onPage={onPage} onSize={onSize} />
        </Card>
      )}
      <OrderSheet orderKey={search.order} result={result} onClose={onClose} />
    </main>
  );
}

function Problem({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <Alert variant="destructive" className="border-crit/30 bg-crit-soft">
      <CircleAlert />
      <AlertTitle className="text-crit">{title}</AlertTitle>
      <AlertDescription className="text-crit">{children}</AlertDescription>
    </Alert>
  );
}

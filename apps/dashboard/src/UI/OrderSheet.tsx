import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@leads/ui/components/collapsible';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@leads/ui/components/sheet';
import { Skeleton } from '@leads/ui/components/skeleton';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import type { OrderColumn, OrderDetail, OrderField, SelectedOrder } from '#Core/Orders/Domain/order';
import type { OrdersResult } from '#Entrypoints/Dashboard/orders';

import { CopyButton } from './CopyButton';
import { dateTime, fmt } from './format';
import { TypeBadge, Value } from './OrdersTable';

/** The sections of the sheet, and the label of each field in them. A field that the source type lacks does not show. */
const sections: readonly {
  readonly title: string;
  readonly fields: readonly { readonly field: OrderField; readonly label: string; readonly mono?: boolean }[];
}[] = [
  {
    title: 'Contact',
    fields: [
      { field: 'ownerName', label: 'Owner' },
      { field: 'phone', label: 'Phone', mono: true },
      { field: 'mobile', label: 'Mobile', mono: true },
      { field: 'email', label: 'Email' },
    ],
  },
  {
    title: 'Address',
    fields: [
      { field: 'street', label: 'Street' },
      { field: 'zip', label: 'Zip', mono: true },
      { field: 'city', label: 'City' },
    ],
  },
  {
    title: 'Other',
    fields: [
      { field: 'uid', label: 'UID', mono: true },
      { field: 'subjectNumber', label: 'Subject number', mono: true },
      { field: 'companyAdditional', label: 'Company additional' },
    ],
  },
];

const keyOf = (selected: SelectedOrder) => (selected.found ? selected.detail.row.key : selected.key);

/**
 * The key and the selected order of the last open sheet, so that the sheet keeps its content while it closes. The
 * selected order counts only when it is the order of the key: a click on a row reads it again.
 */
function useShown(orderKey: string | undefined, selected: SelectedOrder | undefined) {
  const [key, setKey] = useState(orderKey);
  const [order, setOrder] = useState(selected);
  if (orderKey !== undefined && orderKey !== key) setKey(orderKey);
  if (selected !== undefined && selected !== order) setOrder(selected);
  return { key, order: order !== undefined && keyOf(order) === key ? order : undefined };
}

/**
 * All the data of one order in a sheet at the right side of the page. The `order` key of the URL opens it, and the
 * escape key or a click outside closes it. The order comes from all the stored orders, so a filter does not close it.
 */
export function OrderSheet({
  orderKey,
  result,
  onClose,
}: {
  /** The key of the open order, or `undefined` when the sheet is closed. */
  readonly orderKey: string | undefined;
  /** No result while the read loads. */
  readonly result: OrdersResult | undefined;
  readonly onClose: () => void;
}) {
  const selected = result?.ok === true ? result.page.selected : undefined;
  const shown = useShown(orderKey, selected);
  return (
    <Sheet open={orderKey !== undefined} onOpenChange={(open) => open || onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[520px]">
        {shown.order?.found === true ? (
          <Detail detail={shown.order.detail} />
        ) : (
          <Message title={shown.order === undefined ? 'Order' : 'Order not found'}>
            {result?.ok === false ? (
              <p className="text-crit">Cannot read the orders. {result.error}</p>
            ) : shown.order === undefined ? (
              <Loading />
            ) : (
              <p>
                No stored order has the key <code className="font-mono break-all">{shown.key}</code>. The link can be
                old, or the key can be wrong.
              </p>
            )}
          </Message>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Detail({ detail: { row, fields, columns } }: { readonly detail: OrderDetail }) {
  const has = new Set(fields);
  return (
    <>
      <SheetHeader className="gap-3 border-b px-5 py-5 pr-14 text-left md:px-6">
        <SheetTitle className="text-xl leading-tight font-extrabold tracking-tight">
          <Value>{row.name}</Value>
        </SheetTitle>
        <SheetDescription asChild>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <TypeBadge type={row.type} />
            <span className="flex min-w-0 items-center gap-1">
              <code className="truncate font-mono text-xs" title={row.key}>
                {row.key}
              </code>
              <CopyButton text={row.key} label="Copy the key of the order" />
            </span>
          </div>
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-5 py-5 md:px-6">
        {sections.map(({ title, fields: sectionFields }) => {
          const shown = sectionFields.filter(({ field }) => has.has(field));
          if (shown.length === 0) return null;
          return (
            <Section key={title} title={title}>
              {shown.map(({ field, label, mono = false }) => (
                <Fact key={field} label={label}>
                  <Value mono={mono}>{row[field]}</Value>
                </Fact>
              ))}
            </Section>
          );
        })}
        <Section title="Storage">
          <Fact label="Stored">
            {row.storedAt === undefined ? (
              <span className="text-muted-foreground">Not recorded. The order is older than the time of storage.</span>
            ) : (
              <span title={row.storedAt}>{dateTime(row.storedAt)}</span>
            )}
          </Fact>
        </Section>
        <OriginalColumns columns={columns} />
      </div>
    </>
  );
}

/** All the columns of the workbook row, in the order of the header. Closed at first, so that the sheet stays short. */
function OriginalColumns({ columns }: { readonly columns: readonly OrderColumn[] }) {
  return (
    <Collapsible className="overflow-hidden rounded-lg border">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 bg-muted/40 px-4 py-2.5 text-left text-sm font-semibold outline-none hover:bg-muted focus-visible:bg-muted">
        <ChevronRight className="size-4 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
        Original columns
        <span className="font-normal text-muted-foreground">{fmt(columns.length)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid grid-cols-[minmax(0,11rem)_1fr] gap-x-4 gap-y-2 border-t px-4 py-3 text-sm">
          {columns.map(({ name, value }) => (
            <Fact key={name} label={<span className="font-mono text-xs">{name}</span>}>
              <Value>{value}</Value>
            </Fact>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
      <dl className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-4 gap-y-2 text-sm">{children}</dl>
    </section>
  );
}

function Fact({ label, children }: { readonly label: ReactNode; readonly children: ReactNode }) {
  return (
    <>
      <dt className="min-w-0 break-words text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Message({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <>
      <SheetHeader className="border-b px-5 py-5 pr-14 text-left md:px-6">
        <SheetTitle className="text-xl leading-tight font-extrabold tracking-tight">{title}</SheetTitle>
      </SheetHeader>
      <SheetDescription asChild>
        <div className="px-5 py-5 text-sm md:px-6">{children}</div>
      </SheetDescription>
    </>
  );
}

function Loading() {
  return (
    <div className="flex flex-col gap-3" aria-label="Loading the order">
      {Array.from({ length: 6 }, (_, index) => (
        <Skeleton key={index} className="h-5 w-full max-w-80" />
      ))}
    </div>
  );
}

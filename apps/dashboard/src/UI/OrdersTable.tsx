import type { LeadSourceType } from '@leads/shared/domain/types';
import { Badge } from '@leads/ui/components/badge';
import { Skeleton } from '@leads/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@leads/ui/components/table';
import { cn } from '@leads/ui/lib/utils';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import type { ReactNode } from 'react';

import type { OrderRow } from '#Core/Orders/Domain/order';
import type { OrderSort, OrderSortKey } from '#Core/Orders/Domain/orderSort';

import { dateTime, typeLabels } from './format';

/** The columns of the table, and the sort key of each column that sorts the orders. */
const columns: readonly { readonly label: string; readonly sort?: OrderSortKey }[] = [
  { label: 'Name', sort: 'name' },
  { label: 'City', sort: 'city' },
  { label: 'Zip', sort: 'zip' },
  { label: 'Phone' },
  { label: 'Type', sort: 'type' },
  { label: 'Stored', sort: 'storedAt' },
];

/** The number of placeholder rows while the first read loads. */
const placeholderRows = 8;

/** One color for each source type, so that the three types are easy to tell apart. */
const typeClasses: Record<LeadSourceType, string> = {
  new_acquisition: 'border-ok/30 bg-ok-soft text-ok',
  business_closure: 'border-warn/30 bg-warn-soft text-warn',
  mutation: 'border-live/30 bg-live-soft text-live',
};

export function TypeBadge({ type }: { readonly type: LeadSourceType }) {
  return (
    <Badge variant="outline" className={cn('font-semibold', typeClasses[type])}>
      {typeLabels[type]}
    </Badge>
  );
}

/** A dash for an empty value, so that an empty cell is not taken for a cell that still loads. */
export function Value({ children, mono = false }: { readonly children: string | undefined; readonly mono?: boolean }) {
  if (children === undefined || children === '') return <span className="text-muted-foreground">—</span>;
  return <span className={cn(mono && 'font-mono text-[13px]')}>{children}</span>;
}

/**
 * The table of one page of orders. No rows while the first read loads: it shows placeholder rows instead. A click on
 * the header of a column sorts the orders by it, and the header of the sorted column shows the direction. When orders
 * are stored but no row matches the filters, a message says so, so that the empty table does not look like a failed
 * read. A click on a row, or the enter or space key on a focused row, opens the order.
 */
export function OrdersTable({
  rows,
  storedTotal,
  sort,
  openKey,
  onSort,
  onOpen,
  onClear,
}: {
  readonly rows: readonly OrderRow[] | undefined;
  /** The count of all the stored orders, from the same read as the rows. */
  readonly storedTotal: number | undefined;
  readonly sort: OrderSort;
  /** The key of the order that the sheet shows, if any. */
  readonly openKey: string | undefined;
  readonly onSort: (key: OrderSortKey) => void;
  readonly onOpen: (key: string) => void;
  readonly onClear: () => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map(({ label, sort: key }) => (
            <TableHead
              key={label}
              className="font-semibold text-muted-foreground"
              aria-sort={key === sort.sort ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
            >
              {key === undefined ? (
                label
              ) : (
                <SortButton active={key === sort.sort} dir={sort.dir} onClick={() => onSort(key)}>
                  {label}
                </SortButton>
              )}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows === undefined ? (
          <Placeholders />
        ) : rows.length === 0 && storedTotal !== 0 ? (
          <Empty>
            <p className="font-semibold text-foreground">No order matches the filters.</p>
            <p className="mt-1">
              Change the search or the type, or{' '}
              <button
                type="button"
                className="font-semibold text-foreground underline underline-offset-4 hover:no-underline"
                onClick={onClear}
              >
                clear the filters
              </button>
              .
            </p>
          </Empty>
        ) : rows.length === 0 ? (
          <Empty>No orders yet. The lead handler stores each lead of a workbook as one order.</Empty>
        ) : (
          rows.map((row) => (
            <TableRow
              key={row.key}
              tabIndex={0}
              data-state={row.key === openKey ? 'selected' : undefined}
              aria-label={`Open the order ${row.name ?? row.key}`}
              className="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              onClick={() => onOpen(row.key)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                onOpen(row.key);
              }}
            >
              <TableCell className="font-semibold">
                <Value>{row.name}</Value>
              </TableCell>
              <TableCell>
                <Value>{row.city}</Value>
              </TableCell>
              <TableCell>
                <Value mono>{row.zip}</Value>
              </TableCell>
              <TableCell>
                <Value mono>{row.phone}</Value>
              </TableCell>
              <TableCell>
                <TypeBadge type={row.type} />
              </TableCell>
              <TableCell title={row.storedAt}>
                <Value>{row.storedAt === undefined ? undefined : dateTime(row.storedAt)}</Value>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

/** The header of a column that sorts. The sorted column shows its direction, and the others a quiet hint. */
function SortButton({
  active,
  dir,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly dir: OrderSort['dir'];
  readonly onClick: () => void;
  readonly children: string;
}) {
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        '-mx-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        active && 'text-foreground'
      )}
    >
      {children}
      <Icon aria-hidden className={cn('size-3.5', !active && 'opacity-40')} />
    </button>
  );
}

function Placeholders() {
  return Array.from({ length: placeholderRows }, (_, index) => (
    <TableRow key={index} aria-hidden>
      {columns.map((column) => (
        <TableCell key={column.label}>
          <Skeleton className="h-5 w-full max-w-36" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

function Empty({ children }: { readonly children: ReactNode }) {
  return (
    <TableRow>
      <TableCell colSpan={columns.length} className="py-12 text-center text-muted-foreground">
        {children}
      </TableCell>
    </TableRow>
  );
}

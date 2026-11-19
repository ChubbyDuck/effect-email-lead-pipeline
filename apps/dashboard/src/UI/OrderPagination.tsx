import { Button } from '@leads/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@leads/ui/components/select';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import type { OrderPage } from '#Core/Orders/Domain/order';
import { type OrderPageSize, OrderPageSizes, toOrderPageSize } from '#Core/Orders/Domain/orderPaging';

import { fmt } from './format';

/**
 * The rows of the page as "n–m of total". An empty result has no rows to count from, so it shows "0 of 0". A page of
 * one row shows "n of total", not "n–n of total".
 */
const rangeOf = ({ page, size, rows, total }: OrderPage) => {
  if (total === 0) return '0 of 0';
  const first = (page - 1) * size + 1;
  const last = first + rows.length - 1;
  if (first === last) return `${fmt(first)} of ${fmt(total)}`;
  return `${fmt(first)}–${fmt(last)} of ${fmt(total)}`;
};

/**
 * The row below the table: the page size, the place in the list, and the buttons of the previous and the next page.
 * The UI kit has no pagination component, so the buttons are made of `Button`. The previous button is off on the first
 * page, and the next button is off on the last page. Without a page, while the first read loads or after a failed
 * read, both buttons are off.
 */
export function OrderPagination({
  orderPage,
  size,
  onPage,
  onSize,
}: {
  readonly orderPage: OrderPage | undefined;
  /** The page size of the URL, so that the select shows a new choice before the new page loads. */
  readonly size: OrderPageSize;
  readonly onPage: (page: number) => void;
  readonly onSize: (size: OrderPageSize) => void;
}) {
  return (
    <nav
      aria-label="Pages of the orders"
      className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t px-4 py-3 text-muted-foreground"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>Rows per page</span>
        <Select value={String(size)} onValueChange={(value) => onSize(toOrderPageSize(Number(value)))}>
          <SelectTrigger aria-label="Rows per page" size="sm" className="bg-card font-semibold text-foreground">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OrderPageSizes.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {choice}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="ml-auto flex items-center gap-4">
        {orderPage !== undefined && (
          <p aria-live="polite" className="flex gap-4 tabular-nums">
            <span>{rangeOf(orderPage)}</span>
            <span className="font-semibold text-foreground">
              Page {fmt(orderPage.page)} of {fmt(orderPage.pages)}
            </span>
          </p>
        )}
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="icon"
            aria-label="Previous page"
            disabled={orderPage === undefined || orderPage.page <= 1}
            onClick={() => orderPage !== undefined && onPage(orderPage.page - 1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label="Next page"
            disabled={orderPage === undefined || orderPage.page >= orderPage.pages}
            onClick={() => orderPage !== undefined && onPage(orderPage.page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </nav>
  );
}

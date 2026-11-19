import type { LeadSourceType } from '@leads/shared/domain/types';
import { Button } from '@leads/ui/components/button';
import { Input } from '@leads/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@leads/ui/components/select';
import { Search, X } from 'lucide-react';

import { isFiltered, OrderSourceTypes, type OrderTypeFilter, toOrderTypeFilter } from '#Core/Orders/Domain/orderFilter';

import { fmt, typeLabels } from './format';

/** The label of a choice of the type select, with its count when the counts are known. */
const choiceLabel = (label: string, count: number | undefined) =>
  count === undefined ? label : `${label} (${fmt(count)})`;

/**
 * The filter bar: the search field, the type select, and the clear button. The select shows the count of each source
 * type after the search, so each choice shows what it gives. The clear button shows only when a filter is on, also a
 * search text that waits for the pause.
 */
export function OrderFilters({
  text,
  type,
  counts,
  onText,
  onType,
  onClear,
}: {
  readonly text: string;
  readonly type: OrderTypeFilter;
  /** No counts while the first read loads. */
  readonly counts: Readonly<Record<LeadSourceType, number>> | undefined;
  readonly onText: (text: string) => void;
  readonly onType: (type: OrderTypeFilter) => void;
  readonly onClear: () => void;
}) {
  const all = counts === undefined ? undefined : OrderSourceTypes.reduce((sum, choice) => sum + counts[choice], 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full sm:w-80">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          type="search"
          aria-label="Search the orders"
          placeholder="Search name, city, phone, email…"
          className="h-10 rounded-[10px] bg-card pl-9"
          value={text}
          onChange={(event) => onText(event.target.value)}
        />
      </div>
      <Select value={type} onValueChange={(value) => onType(toOrderTypeFilter(value))}>
        <SelectTrigger aria-label="Source type" className="h-10 rounded-[10px] bg-card font-semibold">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{choiceLabel('All types', all)}</SelectItem>
          {OrderSourceTypes.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {choiceLabel(typeLabels[choice], counts?.[choice])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isFiltered({ q: text, type }) && (
        <Button variant="ghost" className="h-10 rounded-[10px] font-semibold" onClick={onClear}>
          <X />
          Clear filters
        </Button>
      )}
    </div>
  );
}

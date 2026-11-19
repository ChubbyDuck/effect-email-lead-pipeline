import { Link, useLocation } from '@tanstack/react-router';

import { defaultWindowHours } from '#Core/Observation/Domain/time';

/** A link is active on its own path, whatever the time window or the request in the URL. */
const activeOptions = { exact: true, includeSearch: false };

/** Both links have the same box, so that a link stays in its place from one page to the next. */
const pageLink =
  'rounded-[5px] border border-transparent px-[9px] py-1 font-mono text-xs font-semibold text-primary hover:underline data-[status=active]:border-border/70 data-[status=active]:bg-muted/45 data-[status=active]:text-foreground data-[status=active]:hover:no-underline';

/** The header of the lab, on the pipeline page and on the simulator: the brand, the name of the current page, and a link to each page. */
export function AppHeader() {
  const onSimulator = useLocation({ select: ({ pathname }) => pathname === '/simulator' });
  return (
    <header className="sticky top-0 z-10 flex h-[59px] items-center justify-between border-b border-border/70 bg-card px-[18px] leading-[normal] min-[761px]:h-[68px] min-[761px]:px-[30px]">
      <Link
        className="flex items-center gap-[11px] text-[22px] font-bold tracking-[-1px] min-[761px]:text-2xl"
        search={{ hours: defaultWindowHours }}
        to="/"
      >
        <span aria-hidden className="flex h-[23px] items-end gap-[3px]">
          <i className="h-3 w-[5px] rounded-[2px] bg-primary" />
          <i className="h-[22px] w-[5px] rounded-[2px] bg-primary" />
          <i className="h-[17px] w-[5px] rounded-[2px] bg-primary" />
        </span>
        leads
        <span className="mx-1 hidden h-[21px] w-px bg-border/70 min-[480px]:block" />
        <span className="hidden text-[13px] font-medium tracking-normal text-muted-foreground min-[480px]:block">
          {onSimulator ? 'Burst simulator' : 'Pipeline'}
        </span>
      </Link>
      <div className="flex items-center gap-6">
        <span className="hidden font-mono text-[10px] tracking-[1px] text-muted-foreground/72 min-[761px]:block">
          Inbox → sources → leads
        </span>
        <nav aria-label="Pages" className="flex items-center gap-1">
          <Link activeOptions={activeOptions} className={pageLink} search={{ hours: defaultWindowHours }} to="/">
            Pipeline
          </Link>
          <Link activeOptions={activeOptions} className={pageLink} to="/simulator">
            Simulator
          </Link>
        </nav>
      </div>
    </header>
  );
}

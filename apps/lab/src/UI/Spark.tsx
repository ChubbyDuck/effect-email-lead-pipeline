import { cn } from '@leads/ui/lib/utils';

import type { Series } from '#Core/Observation/Domain/snapshot';

import { fmt, time } from './format';

/** The bars of one series. `errors` paints a second series over it in red. */
export function Spark({
  series,
  errors,
  className,
}: {
  readonly series: Series;
  readonly errors?: Series;
  readonly className?: string;
}) {
  const top = Math.max(1, ...series.values, ...(errors?.values ?? []));
  const start = Date.parse(series.start);
  return (
    <svg
      className={cn('block h-7 w-full', className)}
      viewBox={`0 0 ${series.values.length} 10`}
      preserveAspectRatio="none"
    >
      {/* The baseline: a series of zeros still shows that it has periods. */}
      <rect className="fill-border" x={0} y={9.6} width={series.values.length} height={0.4} />
      {series.values.map((value, index) => {
        const at = time(new Date(start + index * series.periodSeconds * 1000).toISOString());
        const error = errors?.values[index] ?? 0;
        const height = (value / top) * 10;
        const errorHeight = (error / top) * 10;
        const label = `${at}: ${fmt(Math.round(value * 100) / 100)}${error ? `, ${error} errors` : ''}`;
        return (
          <g key={index}>
            <title>{label}</title>
            <rect className="fill-live/45" x={index + 0.1} y={10 - height} width={0.8} height={height} />
            {error > 0 && (
              <rect className="fill-crit" x={index + 0.1} y={10 - errorHeight} width={0.8} height={errorHeight} />
            )}
            <rect x={index} y={0} width={1} height={10} fill="transparent" />
          </g>
        );
      })}
    </svg>
  );
}

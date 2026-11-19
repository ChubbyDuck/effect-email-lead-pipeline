import { Alert, AlertDescription } from '@leads/ui/components/alert';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@leads/ui/components/card';
import { Skeleton } from '@leads/ui/components/skeleton';
import { cn } from '@leads/ui/lib/utils';
import { CircleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import type { Section, Snapshot } from '#Core/Observation/Domain/snapshot';

export function Panel({
  title,
  description,
  action,
  className,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Card className={cn('gap-4 rounded-2xl py-5 shadow-none', className)}>
      <CardHeader className="px-4 md:px-6">
        <CardTitle className="flex items-center gap-2.5 text-lg font-extrabold tracking-tight">{title}</CardTitle>
        {description !== undefined && <CardDescription>{description}</CardDescription>}
        {action !== undefined && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="px-4 md:px-6">{children}</CardContent>
    </Card>
  );
}

export const Loading = ({ rows = 3 }: { readonly rows?: number }) => (
  <div className="flex flex-col gap-2" aria-label="Loading">
    {Array.from({ length: rows }, (_, index) => (
      <Skeleton key={index} className="h-5" style={{ width: `${92 - index * 14}%` }} />
    ))}
  </div>
);

export const SectionError = ({ error }: { readonly error: string }) => (
  <Alert variant="destructive" className="border-crit/30 bg-crit-soft">
    <CircleAlert />
    <AlertDescription className="text-crit">Cannot read: {error}</AlertDescription>
  </Alert>
);

/** One section of the snapshot, or its error. Before the first snapshot, it shows that the section loads. */
export function SectionView<T>({
  snapshot,
  select,
  children,
}: {
  readonly snapshot: Snapshot | undefined;
  readonly select: (snapshot: Snapshot) => Section<T>;
  readonly children: (value: T, snapshot: Snapshot) => ReactNode;
}) {
  if (snapshot === undefined) return <Loading />;
  const section = select(snapshot);
  if (!section.ok) return <SectionError error={section.error} />;
  return children(section.value, snapshot);
}

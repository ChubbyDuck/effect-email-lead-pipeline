import { Badge } from '@leads/ui/components/badge';
import { cn } from '@leads/ui/lib/utils';
import type { ReactNode } from 'react';

/** The meaning of a color on the page. Only health has a color; the rest of the page is neutral. */
export type Tone = 'ok' | 'info' | 'warning' | 'critical' | 'neutral';

export const toneText: Record<Tone, string> = {
  ok: 'text-ok',
  info: 'text-live',
  warning: 'text-warn',
  critical: 'text-crit',
  neutral: 'text-muted-foreground',
};

export const toneFill: Record<Tone, string> = {
  ok: 'bg-ok',
  info: 'bg-live',
  warning: 'bg-warn',
  critical: 'bg-crit',
  neutral: 'bg-muted-foreground/40',
};

const toneSurface: Record<Tone, string> = {
  ok: 'bg-ok-soft text-ok',
  info: 'bg-live-soft text-live',
  warning: 'bg-warn-soft text-warn',
  critical: 'bg-crit-soft text-crit',
  neutral: 'bg-muted text-muted-foreground',
};

/** A short state, such as `done` or `Active`, in the color of its health. */
export function Tag({
  tone,
  title,
  className,
  children,
}: {
  readonly tone: Tone;
  readonly title?: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Badge
      variant="secondary"
      title={title}
      className={cn('rounded-full px-2.5 font-bold', toneSurface[tone], className)}
    >
      {children}
    </Badge>
  );
}

import { cn } from '@leads/ui/lib/utils';
import type { ReactNode } from 'react';

/** How a cost was calculated, under the cost, with the raw prices. */
export const Formula = ({ children, className }: { readonly children: ReactNode; readonly className?: string }) => (
  <span
    className={cn(
      'block font-mono text-[11px] leading-snug font-normal tracking-normal break-words whitespace-normal text-muted-foreground normal-case',
      className
    )}
  >
    {children}
  </span>
);

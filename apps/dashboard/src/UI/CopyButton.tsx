import { cn } from '@leads/ui/lib/utils';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/**
 * A small button that copies a text, and shows a check for a moment after the copy. When the browser refuses the copy,
 * the button stays as it is, so it does not say that a copy happened.
 */
export function CopyButton({ text, label }: { readonly text: string; readonly label: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={() => void copy()}
      className="inline-flex flex-none cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 font-sans text-xs font-semibold text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className={cn('size-3.5', copied && 'text-ok')} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

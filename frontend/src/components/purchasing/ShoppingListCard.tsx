import type { MouseEventHandler } from 'react';

export type ShoppingListCardProps = {
  name: string;
  lineCount: number;
  lineCountLabel: string;
  createdAt: string;
  onSelect: MouseEventHandler<HTMLButtonElement>;
};

export function ShoppingListCard({ name, lineCount, lineCountLabel, createdAt, onSelect }: ShoppingListCardProps) {
  return (
    <button type="button" className="min-h-24 w-full rounded-xl border border-border bg-card p-4 text-start shadow-sm transition hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onSelect}>
      <span className="block truncate font-semibold">{name}</span>
      <span className="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><span>{lineCount} · {lineCountLabel}</span><span>·</span><span>{createdAt}</span></span>
    </button>
  );
}

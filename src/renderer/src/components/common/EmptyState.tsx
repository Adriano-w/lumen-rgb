import type * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Acao principal — no maximo uma, para a tela ter um caminho obvio. */
  action?: React.ReactNode;
  /** Acao secundaria, discreta. */
  secondaryAction?: React.ReactNode;
  tone?: 'neutral' | 'danger';
  className?: string;
}

/** Tela de estado centralizada: vazio, erro, desconectado, carregando. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  tone = 'neutral',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col items-center justify-center gap-6 px-8 py-16 text-center',
        className,
      )}
    >
      <div
        className={cn(
          'flex size-16 items-center justify-center rounded-xl border',
          tone === 'danger'
            ? 'border-destructive/25 bg-destructive/10 text-destructive'
            : 'border-border bg-surface-2 text-muted-foreground',
        )}
      >
        <Icon className="size-7" aria-hidden />
      </div>

      <div className="flex max-w-md flex-col gap-2">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
      </div>

      {action || secondaryAction ? (
        <div className="flex flex-col items-center gap-3">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

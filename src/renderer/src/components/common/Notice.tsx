import type * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@renderer/lib/utils';

export type NoticeTone = 'info' | 'warning' | 'success' | 'danger';

const TONES: Record<NoticeTone, { wrapper: string; icon: string }> = {
  info: { wrapper: 'border-info/30 bg-info-soft', icon: 'text-info' },
  warning: { wrapper: 'border-warning/35 bg-warning-soft', icon: 'text-warning' },
  success: { wrapper: 'border-success/30 bg-success-soft', icon: 'text-success' },
  danger: { wrapper: 'border-destructive/30 bg-destructive/8', icon: 'text-destructive' },
};

export interface NoticeProps {
  tone?: NoticeTone;
  icon: LucideIcon;
  title: string;
  /** Detalhe do aviso. Pode ser texto ou uma lista. */
  children?: React.ReactNode;
  /** Acao alinhada a direita — fechar, abrir o device, tentar de novo. */
  action?: React.ReactNode;
  className?: string;
}

/**
 * Aviso em linha: explica uma consequencia sem virar um alerta modal.
 *
 * Usado para contar o que vai acontecer antes de aplicar (device sem modo
 * Direct, desgaste de flash) e o que aconteceu depois.
 */
export function Notice({
  tone = 'info',
  icon: Icon,
  title,
  children,
  action,
  className,
}: NoticeProps) {
  const style = TONES[tone];

  return (
    <div
      className={cn('flex items-start gap-3 rounded-lg border p-3.5', style.wrapper, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', style.icon)} aria-hidden />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-sm font-medium leading-snug text-foreground">{title}</p>
        {children ? (
          <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>
        ) : null}
      </div>

      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

import type * as React from 'react';
import { cn } from '@renderer/lib/utils';

export interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  description?: string;
  /** Controle alinhado a direita do titulo. */
  aside?: React.ReactNode;
}

/**
 * Bloco de conteudo separado por espaco e um titulo, nao por caixa.
 * Evita painel dentro de painel, que e o que faz telas de RGB parecerem
 * cabine de aviao.
 */
export function Section({
  title,
  description,
  aside,
  className,
  children,
  ...props
}: SectionProps) {
  return (
    <section className={cn('flex flex-col gap-4', className)} {...props}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
            {title}
          </h3>
          {description ? (
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

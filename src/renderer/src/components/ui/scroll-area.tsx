import * as React from 'react';
import { ScrollArea as ScrollAreaPrimitive } from 'radix-ui';
import { cn } from '@renderer/lib/utils';

export interface ScrollAreaProps
  extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  /** Classe aplicada ao viewport interno, onde o conteudo realmente mora. */
  viewportClassName?: string;
}

export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, viewportClassName, children, ...props }, ref) => (
    <ScrollAreaPrimitive.Root
      ref={ref}
      type="hover"
      scrollHideDelay={400}
      className={cn('relative overflow-hidden', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        className={cn(
          'size-full rounded-[inherit]',
          // O Radix envolve o conteudo num div com `display: table`, que faz o
          // filho crescer pela largura intrinseca do texto. Isso anula
          // `truncate` e produz scroll horizontal indevido. Forcar `block` +
          // largura total devolve o conteudo a largura do viewport.
          '[&>div]:!block [&>div]:!w-full [&>div]:min-w-0',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>

      <ScrollAreaPrimitive.Scrollbar
        orientation="vertical"
        className={cn(
          'flex w-2.5 touch-none select-none p-0.5 transition-opacity duration-200',
          'data-[state=hidden]:opacity-0',
        )}
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border-strong hover:bg-muted-foreground" />
      </ScrollAreaPrimitive.Scrollbar>

      <ScrollAreaPrimitive.Scrollbar
        orientation="horizontal"
        className={cn(
          'flex h-2.5 flex-col touch-none select-none p-0.5 transition-opacity duration-200',
          'data-[state=hidden]:opacity-0',
        )}
      >
        <ScrollAreaPrimitive.Thumb className="relative flex-1 rounded-full bg-border-strong hover:bg-muted-foreground" />
      </ScrollAreaPrimitive.Scrollbar>

      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  ),
);
ScrollArea.displayName = 'ScrollArea';

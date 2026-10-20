import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import { cn } from '@renderer/lib/utils';

/**
 * Caixa de selecao do Radix.
 *
 * Operavel por teclado (Tab para focar, Espaco para marcar) e com estado
 * indeterminado, usado quando so uma parte da lista esta selecionada.
 */
export const Checkbox = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, checked, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    checked={checked}
    className={cn(
      'flex size-4.5 shrink-0 cursor-pointer items-center justify-center rounded-[0.3rem] border',
      'transition-colors duration-150',
      'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      'disabled:cursor-not-allowed disabled:opacity-45',
      'border-border-strong bg-card text-primary-foreground',
      'hover:border-primary/60',
      'data-[state=checked]:border-primary data-[state=checked]:bg-primary',
      'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary',
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center">
      {checked === 'indeterminate' ? (
        <Minus className="size-3" aria-hidden />
      ) : (
        <Check className="size-3" aria-hidden />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = 'Checkbox';

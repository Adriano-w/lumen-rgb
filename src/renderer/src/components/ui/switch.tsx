import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';
import { cn } from '@renderer/lib/utils';

export const Switch = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5.5 w-10 shrink-0 cursor-pointer items-center rounded-full',
      'border-2 border-transparent transition-colors',
      'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      'disabled:cursor-not-allowed disabled:opacity-45',
      'data-[state=checked]:bg-primary data-[state=unchecked]:bg-surface-3',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-4 rounded-full bg-card shadow-soft ring-0',
        'transition-transform data-[state=checked]:translate-x-[1.125rem] data-[state=unchecked]:translate-x-0.5',
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

export interface SwitchFieldProps
  extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  label: string;
  description?: string;
}

/** Linha de configuracao: rotulo + descricao a esquerda, switch a direita. */
export function SwitchField({ label, description, id, className, ...props }: SwitchFieldProps) {
  const generatedId = React.useId();
  const switchId = id ?? generatedId;
  const descriptionId = description ? `${switchId}-desc` : undefined;

  return (
    <div className={cn('flex items-start justify-between gap-6 py-1', className)}>
      <div className="flex flex-col gap-0.5">
        <label htmlFor={switchId} className="cursor-pointer text-sm font-medium text-foreground">
          {label}
        </label>
        {description ? (
          <p id={descriptionId} className="max-w-prose text-xs leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      <Switch id={switchId} aria-describedby={descriptionId} className="mt-0.5" {...props} />
    </div>
  );
}

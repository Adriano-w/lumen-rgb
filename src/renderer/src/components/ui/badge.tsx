import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/lib/utils';

const badgeVariants = cva(
  cn(
    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
    'text-[0.6875rem] font-medium leading-4 whitespace-nowrap',
    '[&_svg]:size-3 [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        neutral: 'border-border bg-surface-2 text-muted-foreground',
        primary: 'border-transparent bg-primary-soft text-accent-foreground',
        success: 'border-transparent bg-success-soft text-success',
        warning: 'border-transparent bg-warning-soft text-warning-foreground',
        danger: 'border-transparent bg-destructive/15 text-destructive',
        info: 'border-transparent bg-info-soft text-info',
        outline: 'border-border-strong bg-transparent text-muted-foreground',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };

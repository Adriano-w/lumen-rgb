import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@renderer/lib/utils';

const buttonVariants = cva(
  cn(
    'inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap',
    'rounded-md text-sm font-medium transition-[background-color,color,box-shadow,border-color] duration-150',
    'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    'disabled:pointer-events-none disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ),
  {
    variants: {
      variant: {
        primary: 'bg-primary text-primary-foreground shadow-soft hover:brightness-110 active:brightness-95',
        secondary:
          'bg-secondary text-secondary-foreground border border-border hover:bg-surface-3 active:bg-muted',
        outline:
          'border border-border-strong bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground',
        ghost: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        danger: 'bg-destructive text-destructive-foreground shadow-soft hover:brightness-110',
        'danger-ghost':
          'bg-transparent text-destructive hover:bg-destructive/12 focus-visible:outline-destructive',
        link: 'bg-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs [&_svg]:size-3.5',
        md: 'h-9 px-4 [&_svg]:size-4',
        lg: 'h-11 px-6 text-base [&_svg]:size-5',
        icon: 'size-9 p-0 [&_svg]:size-4',
        'icon-sm': 'size-8 p-0 [&_svg]:size-3.5',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { buttonVariants };

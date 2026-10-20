import * as React from 'react';
import { Tabs as TabsPrimitive } from 'radix-ui';
import { cn } from '@renderer/lib/utils';

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'inline-flex h-10 items-center gap-1 rounded-lg border border-border bg-surface-2 p-1',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = 'TabsList';

export const TabsTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'inline-flex h-8 items-center justify-center gap-2 whitespace-nowrap rounded-md px-3.5',
      'text-sm font-medium text-muted-foreground transition-colors',
      'outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
      'hover:text-foreground',
      'disabled:pointer-events-none disabled:opacity-45',
      'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-soft',
      '[&_svg]:size-4 [&_svg]:shrink-0',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = 'TabsTrigger';

export const TabsContent = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-6 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      'animate-in fade-in-0 duration-200',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = 'TabsContent';

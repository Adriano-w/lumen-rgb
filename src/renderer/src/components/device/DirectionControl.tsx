import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  MoveHorizontal,
  MoveVertical,
  type LucideIcon,
} from 'lucide-react';

import type { DirectionOption } from '@renderer/lib/modes';
import { cn } from '@renderer/lib/utils';

const ICONS: Record<DirectionOption['icon'], LucideIcon> = {
  left: ArrowLeft,
  right: ArrowRight,
  up: ArrowUp,
  down: ArrowDown,
  horizontal: MoveHorizontal,
  vertical: MoveVertical,
};

export interface DirectionControlProps {
  options: DirectionOption[];
  value: number | undefined;
  onChange: (value: number) => void;
  disabled?: boolean;
  className?: string;
}

/** Grupo de botoes de direcao. Some quando o modo nao tem direcao. */
export function DirectionControl({
  options,
  value,
  onChange,
  disabled,
  className,
}: DirectionControlProps) {
  if (options.length === 0) return null;

  return (
    <div
      role="radiogroup"
      aria-label="Direcao"
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-border bg-surface-2 p-1',
        className,
      )}
    >
      {options.map((option) => {
        const Icon = ICONS[option.icon];
        const active = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={option.label}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              'disabled:pointer-events-none disabled:opacity-45',
              active
                ? 'bg-card text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

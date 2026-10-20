import { Palette, Power, Sparkles, type LucideIcon } from 'lucide-react';

import type { BulkMode } from '@renderer/lib/bulk';
import { cn } from '@renderer/lib/utils';

export interface BulkModeToggleProps {
  value: BulkMode;
  onChange: (value: BulkMode) => void;
  disabled?: boolean;
}

const OPTIONS: { value: BulkMode; label: string; hint: string; icon: LucideIcon }[] = [
  {
    value: 'effect',
    label: 'Efeito do Lumen',
    hint: 'Movimento, em sincronia entre os devices',
    icon: Sparkles,
  },
  {
    value: 'color',
    label: 'Cor fixa',
    hint: 'Uma cor so, parada, em todo mundo',
    icon: Palette,
  },
  {
    value: 'off',
    label: 'Desligar',
    hint: 'Apaga a iluminacao dos escolhidos',
    icon: Power,
  },
];

/** Escolha unica do que o lote vai aplicar. Um caminho, tres destinos. */
export function BulkModeToggle({ value, onChange, disabled }: BulkModeToggleProps) {
  return (
    <div
      role="radiogroup"
      aria-label="O que aplicar nos devices escolhidos"
      className="grid gap-3 sm:grid-cols-3"
    >
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = value === option.value;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-all',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              'disabled:pointer-events-none disabled:opacity-45',
              active
                ? 'border-primary bg-primary-soft/60 shadow-soft'
                : 'border-border bg-card hover:border-border-strong',
            )}
          >
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-md border',
                active
                  ? 'border-primary/40 bg-card text-primary'
                  : 'border-border bg-surface-2 text-muted-foreground',
              )}
              aria-hidden
            >
              <Icon className="size-4" />
            </span>

            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium leading-tight text-foreground">
                {option.label}
              </span>
              <span className="text-xs leading-snug text-muted-foreground">{option.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

import { Cpu, Sparkles } from 'lucide-react';

import { Tooltip } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';

export type ModeSource = 'lumen' | 'hardware';

export interface ModeSourceToggleProps {
  value: ModeSource;
  onChange: (value: ModeSource) => void;
  /** Efeitos do Lumen exigem modo Direct no device. */
  lumenAvailable: boolean;
  disabled?: boolean;
}

const OPTIONS: {
  value: ModeSource;
  label: string;
  hint: string;
  icon: typeof Cpu;
}[] = [
  {
    value: 'lumen',
    label: 'Efeitos do Lumen',
    hint: 'Calculados pelo app, com mais opcoes',
    icon: Sparkles,
  },
  {
    value: 'hardware',
    label: 'Modos do hardware',
    hint: 'Gravados no device, funcionam sem o app',
    icon: Cpu,
  },
];

/**
 * Escolha entre o nosso motor de efeitos e os modos do firmware.
 *
 * E a decisao mais importante da tela, entao vira um controle grande e
 * explicado, nao um dropdown escondido.
 */
export function ModeSourceToggle({
  value,
  onChange,
  lumenAvailable,
  disabled,
}: ModeSourceToggleProps) {
  return (
    <div role="radiogroup" aria-label="De onde vem a iluminacao" className="grid gap-3 sm:grid-cols-2">
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const blocked = option.value === 'lumen' && !lumenAvailable;
        const active = value === option.value;

        const button = (
          <button
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || blocked}
            onClick={() => onChange(option.value)}
            className={cn(
              'flex w-full items-start gap-3 rounded-lg border p-4 text-left transition-all',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              blocked && 'cursor-not-allowed opacity-45',
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

        return blocked ? (
          <Tooltip
            key={option.value}
            content="Este device nao expoe um modo Direct, entao o Lumen nao consegue pintar LED por LED nele. Use os modos do hardware."
          >
            <span className="flex" tabIndex={0}>
              {button}
            </span>
          </Tooltip>
        ) : (
          <span key={option.value} className="flex">
            {button}
          </span>
        );
      })}
    </div>
  );
}

import { Check } from 'lucide-react';

import type { RGB } from '@shared/types';
import type { EffectUi } from '@renderer/lib/effects';
import { Badge, Tooltip } from '@renderer/components/ui';
import { EffectPreview } from './EffectPreview';
import { cn } from '@renderer/lib/utils';

export interface EffectCardProps {
  effect: EffectUi;
  selected: boolean;
  /** Paleta atual, para o preview mostrar as cores de verdade. */
  colors: RGB[];
  /**
   * Motivo para o efeito nao poder ser escolhido agora. `undefined`
   * libera o card.
   */
  blockedReason?: string;
  onSelect: () => void;
}

export function EffectCard({ effect, selected, colors, blockedReason, onSelect }: EffectCardProps) {
  const { descriptor, icon: Icon, available } = effect;
  const blocked = Boolean(blockedReason);

  const card = (
    <button
      type="button"
      disabled={blocked}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'group relative flex w-full flex-col gap-3 rounded-lg border p-3.5 text-left transition-all',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        blocked && 'cursor-not-allowed',
        selected
          ? 'border-primary bg-primary-soft/60 shadow-raised'
          : 'border-border bg-card hover:border-border-strong hover:shadow-soft',
      )}
    >
      <div className={cn('relative', blocked && 'opacity-40 saturate-50')}>
        <EffectPreview kind={descriptor.kind} colors={effect.usesPalette ? colors : []} />
      </div>

      <div className={cn('flex items-start gap-2', blocked && 'opacity-55')}>
        <Icon
          className={cn(
            'mt-0.5 size-4 shrink-0',
            selected ? 'text-primary' : 'text-muted-foreground',
          )}
          aria-hidden
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium leading-tight text-foreground">
              {descriptor.label}
            </span>
            {!available ? <Badge variant="outline">Em breve</Badge> : null}
          </span>
          <span className="text-xs leading-snug text-muted-foreground">
            {descriptor.description}
          </span>
        </div>

        {selected ? (
          <span
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            aria-hidden
          >
            <Check className="size-3" />
          </span>
        ) : null}
      </div>
    </button>
  );

  // Botao desabilitado nao emite eventos de ponteiro, entao o gatilho do
  // tooltip precisa ser o envelope, nao o proprio botao.
  return blockedReason ? (
    <Tooltip content={blockedReason}>
      <span className="flex" tabIndex={0}>
        {card}
      </span>
    </Tooltip>
  ) : (
    card
  );
}

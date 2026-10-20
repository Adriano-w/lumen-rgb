import { Plus, Trash } from 'lucide-react';

import type { RGB } from '@shared/types';
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from '@renderer/components/ui';
import { ColorArea } from './ColorArea';
import { readableOn, rgbToCss, rgbToHex } from '@renderer/lib/color';
import { cn } from '@renderer/lib/utils';

export interface ColorListProps {
  colors: RGB[];
  onChange: (colors: RGB[]) => void;
  min: number;
  max: number;
  recentColors?: RGB[];
  onCommitColor?: (color: RGB) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Lista de cores para modos/efeitos multicolor.
 *
 * Respeita `min`/`max`: o botao de remover desaparece no minimo e o de
 * adicionar no maximo, em vez de ficar desabilitado sem explicacao.
 */
export function ColorList({
  colors,
  onChange,
  min,
  max,
  recentColors,
  onCommitColor,
  disabled,
  className,
}: ColorListProps) {
  // `min === 0` e legitimo: o efeito funciona sem paleta nenhuma.
  const canRemove = colors.length > min;
  const canAdd = colors.length < max;

  const replaceAt = (index: number, color: RGB): void => {
    onChange(colors.map((item, i) => (i === index ? color : item)));
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {colors.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
          Sem cores escolhidas — o efeito vai percorrer o espectro inteiro sozinho.
        </p>
      ) : null}

      <ul className="flex flex-col gap-2">
        {colors.map((color, index) => (
          <li key={index} className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Editar a cor ${index + 1} (${rgbToHex(color)})`}
                  className={cn(
                    'flex h-9 flex-1 items-center justify-between gap-3 rounded-md border border-border-strong px-3',
                    'font-mono text-xs uppercase tabular-nums shadow-soft transition-transform',
                    'outline-none hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                  style={{ background: rgbToCss(color), color: readableOn(color) }}
                >
                  <span className="opacity-80">Cor {index + 1}</span>
                  <span>{rgbToHex(color)}</span>
                </button>
              </PopoverTrigger>

              <PopoverContent align="start" className="w-auto max-w-[32rem]">
                <ColorArea
                  color={color}
                  recentColors={recentColors}
                  onChange={(next) => replaceAt(index, next)}
                  onCommit={onCommitColor}
                />
              </PopoverContent>
            </Popover>

            {canRemove ? (
              <Tooltip content="Remover esta cor">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  aria-label={`Remover a cor ${index + 1}`}
                  onClick={() => onChange(colors.filter((_, i) => i !== index))}
                >
                  <Trash />
                </Button>
              </Tooltip>
            ) : (
              <span className="size-8 shrink-0" aria-hidden />
            )}
          </li>
        ))}
      </ul>

      {canAdd ? (
        <Button
          variant="ghost"
          size="sm"
          className="w-fit"
          disabled={disabled}
          onClick={() => {
            const last = colors[colors.length - 1] ?? { r: 255, g: 255, b: 255 };
            onChange([...colors, { ...last }]);
          }}
        >
          <Plus aria-hidden />
          Adicionar cor
          <span className="text-subtle-foreground">
            ({colors.length}/{max})
          </span>
        </Button>
      ) : (
        <p className="text-xs text-subtle-foreground">
          Este modo aceita no maximo {max} {max === 1 ? 'cor' : 'cores'}.
        </p>
      )}
    </div>
  );
}

import type { Device } from '@shared/types';
import { cn, formatLeds } from '@renderer/lib/utils';

export interface ZoneSelectorProps {
  device: Device;
  /** `undefined` = device inteiro. */
  value: number | undefined;
  onChange: (zoneIndex: number | undefined) => void;
}

interface Chip {
  key: string;
  label: string;
  meta: string;
  zoneIndex: number | undefined;
}

/**
 * Seletor de alvo: o device todo ou uma zona especifica.
 *
 * Implementado como `radiogroup` navegavel por setas, para dar o
 * comportamento de teclado que o usuario espera de um grupo de abas sem
 * precisar de paineis separados por zona.
 */
export function ZoneSelector({ device, value, onChange }: ZoneSelectorProps) {
  // Device de zona unica nao precisa de seletor: o alvo e obvio.
  if (device.zones.length <= 1) return null;

  const chips: Chip[] = [
    {
      key: 'all',
      label: 'Device inteiro',
      meta: formatLeds(device.ledCount),
      zoneIndex: undefined,
    },
    ...device.zones.map((zone) => ({
      key: `zone-${zone.index}`,
      label: zone.name,
      meta: zone.resizable && zone.ledsCount === 0 ? 'sem tamanho definido' : formatLeds(zone.ledsCount),
      zoneIndex: zone.index,
    })),
  ];

  const activeIndex = chips.findIndex((chip) => chip.zoneIndex === value);

  const moveFocus = (delta: number): void => {
    const next = (activeIndex + delta + chips.length) % chips.length;
    onChange(chips[next].zoneIndex);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Onde aplicar"
      className="flex flex-wrap gap-2"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          moveFocus(1);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveFocus(-1);
        }
      }}
    >
      {chips.map((chip, index) => {
        const active = index === activeIndex;

        return (
          <button
            key={chip.key}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(chip.zoneIndex)}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-lg border px-3.5 py-2 text-left transition-colors',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
              active
                ? 'border-primary/50 bg-primary-soft text-accent-foreground'
                : 'border-border bg-surface-2 text-muted-foreground hover:border-border-strong hover:text-foreground',
            )}
          >
            <span className="text-sm font-medium leading-tight">{chip.label}</span>
            <span className="text-[0.6875rem] leading-tight opacity-75">{chip.meta}</span>
          </button>
        );
      })}
    </div>
  );
}

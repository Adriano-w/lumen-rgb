import { useEffect, useMemo, useState } from 'react';
import { ShadeSlider, Wheel, hexToHsva, type HsvaColor } from '@uiw/react-color';
import { Check, Pipette } from 'lucide-react';

import type { RGB } from '@shared/types';
import { Tooltip } from '@renderer/components/ui';
import { PRESET_COLORS, hexToRgb, hsvToRgb, rgbToCss, rgbToHex, sameColor } from '@renderer/lib/color';
import { cn } from '@renderer/lib/utils';

export interface ColorAreaProps {
  color: RGB;
  /** Chamado em cada arrasto — pode ser frequente. */
  onChange: (color: RGB) => void;
  /** Chamado ao soltar o controle; bom para gravar em "cores recentes". */
  onCommit?: (color: RGB) => void;
  recentColors?: RGB[];
  disabled?: boolean;
  className?: string;
}

/**
 * Area de cor: roda de matiz, controle de luminosidade, campo hex e
 * paleta. A roda e so uma das formas de escolher — quem sabe o hex
 * digita o hex, quem quer rapido clica na paleta.
 */
export function ColorArea({
  color,
  onChange,
  onCommit,
  recentColors = [],
  disabled,
  className,
}: ColorAreaProps) {
  const hex = rgbToHex(color);

  /** HSVA interno: preserva matiz quando a cor cai para preto. */
  const [hsva, setHsva] = useState<HsvaColor>(() => hexToHsva(hex));
  const [hexDraft, setHexDraft] = useState(hex);

  // Reconcilia quando a cor vem de fora (paleta, perfil, outro alvo).
  useEffect(() => {
    setHexDraft(hex);
    setHsva((current) => {
      const currentRgb = hsvToRgb(current.h, current.s, current.v);
      if (sameColor(currentRgb, color)) return current;
      return hexToHsva(hex);
    });
  }, [hex, color]);

  const emit = (next: HsvaColor, commit: boolean): void => {
    setHsva(next);
    const rgb = hsvToRgb(next.h, next.s, next.v);
    onChange(rgb);
    if (commit) onCommit?.(rgb);
  };

  const palette = useMemo(() => {
    // Recentes primeiro, depois os presets que ainda nao apareceram.
    const seen = new Set(recentColors.map(rgbToHex));
    return [...recentColors, ...PRESET_COLORS.filter((preset) => !seen.has(rgbToHex(preset)))].slice(
      0,
      18,
    );
  }, [recentColors]);

  const commitHexDraft = (): void => {
    const parsed = hexToRgb(hexDraft);
    if (!parsed) {
      setHexDraft(hex);
      return;
    }
    setHsva(hexToHsva(rgbToHex(parsed)));
    onChange(parsed);
    onCommit?.(parsed);
  };

  return (
    <div className={cn('flex flex-wrap items-start gap-8', disabled && 'opacity-50', className)}>
      {/* Roda + luminosidade */}
      <div className="flex flex-col items-center gap-4">
        <Wheel
          color={hsva}
          width={180}
          height={180}
          onChange={(result) => emit({ ...result.hsva, a: 1 }, false)}
          onPointerUp={() => onCommit?.(hsvToRgb(hsva.h, hsva.s, hsva.v))}
          style={disabled ? { pointerEvents: 'none' } : undefined}
        />
        <ShadeSlider
          hsva={hsva}
          width={180}
          height={12}
          radius={9999}
          onChange={(shade) => emit({ ...hsva, ...shade }, false)}
          onPointerUp={() => onCommit?.(hsvToRgb(hsva.h, hsva.s, hsva.v))}
          style={disabled ? { pointerEvents: 'none' } : undefined}
        />
      </div>

      {/* Hex + paleta */}
      <div className="flex min-w-56 flex-1 flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="lumen-hex"
            className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground"
          >
            Codigo da cor
          </label>

          <div className="flex items-center gap-2">
            <span
              className="size-9 shrink-0 rounded-md border border-border-strong shadow-soft"
              style={{ background: rgbToCss(color) }}
              aria-hidden
            />
            <div className="relative flex-1">
              <Pipette
                className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                id="lumen-hex"
                value={hexDraft}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                maxLength={7}
                onChange={(event) => setHexDraft(event.target.value)}
                onBlur={commitHexDraft}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    commitHexDraft();
                  }
                }}
                className={cn(
                  'h-9 w-full rounded-md border border-input bg-surface-1 pl-8 pr-3',
                  'font-mono text-sm uppercase tabular-nums text-foreground',
                  'outline-none transition-colors hover:border-border-strong',
                  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                )}
              />
            </div>
          </div>
          <p className="text-xs text-subtle-foreground">
            RGB {Math.round(color.r)}, {Math.round(color.g)}, {Math.round(color.b)}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
            Cores salvas
          </span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Paleta de cores">
            {palette.map((preset) => {
              const active = sameColor(preset, color);
              const presetHex = rgbToHex(preset);

              return (
                <Tooltip key={presetHex} content={presetHex.toUpperCase()}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Usar a cor ${presetHex}`}
                    aria-pressed={active}
                    onClick={() => {
                      setHsva(hexToHsva(presetHex));
                      onChange(preset);
                      onCommit?.(preset);
                    }}
                    className={cn(
                      'relative flex size-7 items-center justify-center rounded-md border transition-transform',
                      'outline-none hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      'disabled:cursor-not-allowed disabled:hover:scale-100',
                      active ? 'border-foreground' : 'border-border-strong',
                    )}
                    style={{ background: rgbToCss(preset) }}
                  >
                    {active ? (
                      <Check
                        className="size-3.5"
                        style={{ color: preset.r + preset.g + preset.b > 380 ? '#000' : '#fff' }}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

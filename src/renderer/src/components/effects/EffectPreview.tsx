import type { CSSProperties } from 'react';

import type { EffectKind, RGB } from '@shared/types';
import { rgbToCss } from '@renderer/lib/color';
import { cn } from '@renderer/lib/utils';

const RAINBOW =
  'linear-gradient(90deg, #ff0055, #ff9100, #ffe600, #4dff00, #00e6c3, #008cff, #7a3cff, #ff00c8, #ff0055)';

/** Cores de reserva do preview, quando o efeito nao usa paleta. */
const FALLBACK_1 = 'oklch(68% 0.185 293)';
const FALLBACK_2 = 'oklch(70% 0.16 215)';

export interface EffectPreviewProps {
  kind: EffectKind;
  /** Paleta do efeito; vazia significa "o efeito escolhe as cores". */
  colors?: RGB[];
  className?: string;
}

/** Posicoes pseudo-aleatorias, mas estaveis, para a cintilancia. */
const TWINKLE = [
  { left: 6, delay: 0, duration: 1.5 },
  { left: 18, delay: 0.7, duration: 2.1 },
  { left: 30, delay: 1.3, duration: 1.7 },
  { left: 43, delay: 0.3, duration: 2.4 },
  { left: 55, delay: 1.9, duration: 1.6 },
  { left: 66, delay: 1.0, duration: 2.2 },
  { left: 78, delay: 0.5, duration: 1.9 },
  { left: 90, delay: 1.6, duration: 2.0 },
];

/**
 * Miniatura animada do efeito, em CSS puro.
 *
 * Nao e uma simulacao fiel do motor — e uma pista visual honesta do que
 * vai acontecer nos LEDs, para o usuario nao adivinhar pelo nome. O
 * movimento e desligado por `prefers-reduced-motion` no globals.css.
 */
export function EffectPreview({ kind, colors = [], className }: EffectPreviewProps) {
  const c1 = colors[0] ? rgbToCss(colors[0]) : FALLBACK_1;
  const c2 = colors[1] ? rgbToCss(colors[1]) : colors[0] ? rgbToCss(colors[0]) : FALLBACK_2;

  /** Paleta esticada, para degrade e marcha. */
  const paletteStops = (colors.length >= 2 ? colors.map(rgbToCss) : [c1, c2]).join(', ');

  return (
    <div
      aria-hidden
      className={cn(
        'relative h-12 w-full overflow-hidden rounded-md border border-border bg-[oklch(13%_0.012_278)]',
        className,
      )}
    >
      {/* --- Sem movimento espacial --- */}

      {kind === 'static' ? <Fill background={c1} /> : null}

      {kind === 'breathing' ? (
        <Fill background={c1} className="animate-lumen-breathe" />
      ) : null}

      {kind === 'strobe' ? <Fill background={c1} className="animate-lumen-strobe" /> : null}

      {kind === 'color-cycle' ? (
        <Fill
          background={colors.length >= 2 ? `linear-gradient(90deg, ${paletteStops})` : c1}
          className="animate-lumen-hue"
        />
      ) : null}

      {kind === 'fire' ? (
        <>
          <Fill background="linear-gradient(0deg, #ff3b00, #ff9100 55%, #ffd000)" />
          <div className="absolute inset-0 flex origin-bottom items-end">
            {[0, 1, 2, 3, 4, 5, 6, 7].map((index) => (
              <span
                key={index}
                className="h-full flex-1 origin-bottom animate-lumen-flicker"
                style={{
                  background: 'linear-gradient(0deg, #ff2a00, #ffb300 70%, #ffe680)',
                  animationDelay: `${index * 0.17}s`,
                  animationDuration: `${0.6 + (index % 3) * 0.23}s`,
                }}
              />
            ))}
          </div>
        </>
      ) : null}

      {/* --- Movimento ao longo da fita --- */}

      {kind === 'rainbow-wave' ? (
        <div
          className="absolute inset-y-0 left-0 w-[200%] animate-lumen-slide"
          style={{ background: `${RAINBOW}, ${RAINBOW}`, backgroundSize: '50% 100%' }}
        />
      ) : null}

      {kind === 'gradient' ? (
        <div
          className="absolute inset-y-0 left-0 w-[200%] animate-lumen-slide"
          style={{
            background: `linear-gradient(90deg, ${paletteStops}, ${paletteStops})`,
          }}
        />
      ) : null}

      {kind === 'wave' ? (
        <div
          className="absolute inset-y-0 left-0 w-2/5 animate-lumen-travel"
          style={{
            background: `radial-gradient(closest-side, ${c1}, color-mix(in oklab, ${c1} 25%, transparent) 55%, transparent 100%)`,
          }}
        />
      ) : null}

      {kind === 'comet' ? (
        <div
          className="absolute inset-y-0 left-0 w-3/5 animate-lumen-travel"
          style={{
            // Cabeca a direita, rastro apagando para tras.
            background: `linear-gradient(90deg, transparent, color-mix(in oklab, ${c1} 35%, transparent) 65%, ${c1} 100%)`,
          }}
        />
      ) : null}

      {kind === 'scan' ? (
        <div className="absolute inset-0">
          <div
            className="absolute inset-y-0 left-0 w-1/5 animate-lumen-scan"
            style={{
              background: `linear-gradient(90deg, transparent, ${c1} 50%, transparent)`,
            }}
          />
        </div>
      ) : null}

      {kind === 'chase' ? (
        <div
          className="absolute inset-0 animate-lumen-march"
          style={{
            background: `repeating-linear-gradient(90deg, ${c1} 0 8%, transparent 8% 25%, ${c2} 25% 33%, transparent 33% 50%)`,
            backgroundSize: '3rem 100%',
          }}
        />
      ) : null}

      {kind === 'alternating' ? (
        <>
          <div
            className="absolute inset-0 animate-lumen-swap"
            style={{
              background: `repeating-linear-gradient(90deg, ${c1} 0 12.5%, ${c2} 12.5% 25%)`,
            }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: `repeating-linear-gradient(90deg, ${c2} 0 12.5%, ${c1} 12.5% 25%)`,
            }}
          />
        </>
      ) : null}

      {kind === 'twinkle' ? (
        <div className="absolute inset-0">
          {TWINKLE.map((spark) => (
            <span
              key={spark.left}
              className="absolute inset-y-0 w-[6%] animate-lumen-twinkle"
              style={{
                left: `${spark.left}%`,
                background: `radial-gradient(closest-side, ${c1}, transparent)`,
                animationDelay: `${spark.delay}s`,
                animationDuration: `${spark.duration}s`,
              }}
            />
          ))}
        </div>
      ) : null}

      {/* --- Dependem de captura: ainda sem kernel --- */}

      {kind === 'audio-level' ? (
        <div className="absolute inset-0 flex items-end gap-1 px-2 pb-1.5">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((bar) => (
            <span
              key={bar}
              className="h-full flex-1 origin-bottom rounded-sm animate-lumen-level"
              style={{
                background: `linear-gradient(180deg, ${c2}, ${c1})`,
                animationDelay: `${(bar % 6) * 0.11}s`,
                animationDuration: `${0.9 + (bar % 4) * 0.18}s`,
              }}
            />
          ))}
        </div>
      ) : null}

      {kind === 'ambient-screen' ? (
        <>
          <Fill
            background="radial-gradient(120% 90% at 30% 20%, oklch(70% 0.2 250), transparent 70%), radial-gradient(120% 90% at 75% 80%, oklch(68% 0.22 20), transparent 70%)"
            className="animate-lumen-hue"
          />
          <div className="absolute inset-x-3 inset-y-2 rounded-sm border border-white/25" />
        </>
      ) : null}

      {/* Marcas de LED, para a miniatura ler como fita e nao como barra. */}
      <div className="absolute inset-0 flex">
        {Array.from({ length: 16 }, (_, index) => (
          <span key={index} className="h-full flex-1 border-r border-black/30 last:border-r-0" />
        ))}
      </div>
    </div>
  );
}

function Fill({
  background,
  className,
  style,
}: {
  background: string;
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={cn('absolute inset-0', className)} style={{ background, ...style }} />;
}

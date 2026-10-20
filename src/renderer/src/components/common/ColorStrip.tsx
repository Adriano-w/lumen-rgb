import type { RGB } from '@shared/types';
import { isOff, rgbToCss } from '@renderer/lib/color';
import { cn } from '@renderer/lib/utils';

export interface ColorStripProps {
  colors: RGB[];
  /** Quantas faixas mostrar no maximo; o resto e reamostrado. */
  max?: number;
  className?: string;
  /** Mostra uma leve iluminacao sob a faixa — bom para a lista de devices. */
  glow?: boolean;
  label?: string;
}

/** Reamostra a lista para `max` posicoes, preservando a distribuicao. */
function resample(colors: RGB[], max: number): RGB[] {
  if (colors.length <= max) return colors;
  const out: RGB[] = [];
  for (let i = 0; i < max; i += 1) {
    out.push(colors[Math.floor((i * colors.length) / max)]);
  }
  return out;
}

/**
 * Faixa com as cores atuais do alvo. E a unica peca da UI que mostra o
 * estado real do hardware, entao vale a pena ela ser legivel mesmo
 * quando tudo esta apagado (dai o fundo quadriculado).
 */
export function ColorStrip({ colors, max = 24, className, glow, label }: ColorStripProps) {
  const shown = resample(colors, max);
  const allOff = shown.length === 0 || shown.every(isOff);

  return (
    <div
      role="img"
      aria-label={label ?? (allOff ? 'Iluminacao apagada' : 'Cores atuais')}
      className={cn(
        'relative flex h-1.5 w-full overflow-hidden rounded-full',
        allOff && 'checkerboard opacity-60',
        className,
      )}
    >
      {shown.length === 0 ? (
        <div className="h-full w-full bg-surface-3" />
      ) : (
        shown.map((color, index) => (
          <div
            key={index}
            className="h-full flex-1"
            style={{
              background: rgbToCss(color),
              boxShadow: glow && !isOff(color) ? `0 0 6px ${rgbToCss(color)}` : undefined,
            }}
          />
        ))
      )}
    </div>
  );
}

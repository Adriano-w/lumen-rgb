import type { RGB } from '@shared/types';
import { clamp } from './utils';

/** Preto puro — usado como "apagado". */
export const BLACK: RGB = { r: 0, g: 0, b: 0 };

const toHexPair = (value: number): string =>
  clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');

/** RGB -> "#rrggbb" (minusculo, sempre 7 caracteres). */
export function rgbToHex({ r, g, b }: RGB): string {
  return `#${toHexPair(r)}${toHexPair(g)}${toHexPair(b)}`;
}

/**
 * "#rgb" | "#rrggbb" | "rrggbb" -> RGB.
 * Devolve `null` quando a entrada nao e um hex valido, para o input
 * poder deixar o usuario digitar sem brigar com ele a cada tecla.
 */
export function hexToRgb(input: string): RGB | null {
  const raw = input.trim().replace(/^#/, '');

  if (/^[0-9a-f]{3}$/i.test(raw)) {
    return {
      r: parseInt(raw[0] + raw[0], 16),
      g: parseInt(raw[1] + raw[1], 16),
      b: parseInt(raw[2] + raw[2], 16),
    };
  }

  if (/^[0-9a-f]{6}$/i.test(raw)) {
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    };
  }

  return null;
}

/** String CSS pronta para `background`. */
export function rgbToCss({ r, g, b }: RGB): string {
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
}

/** Luminancia relativa (WCAG), 0 = preto, 1 = branco. */
export function luminance({ r, g, b }: RGB): number {
  const channel = (value: number): number => {
    const c = clamp(value, 0, 255) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Cor de texto legivel sobre o fundo informado. */
export function readableOn(color: RGB): string {
  return luminance(color) > 0.42 ? 'oklch(18% 0.02 278)' : 'oklch(98% 0 0)';
}

/** True quando as duas cores sao identicas em todos os canais. */
export function sameColor(a: RGB, b: RGB): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

/** True quando a cor e (quase) apagada. */
export function isOff(color: RGB): boolean {
  return color.r + color.g + color.b < 12;
}

/** Converte HSV (h 0-360, s/v 0-100) para RGB 0-255. */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  const sat = clamp(s, 0, 100) / 100;
  const val = clamp(v, 0, 100) / 100;
  const hue = ((h % 360) + 360) % 360;

  const c = val * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = val - c;

  const [r1, g1, b1] =
    hue < 60
      ? [c, x, 0]
      : hue < 120
        ? [x, c, 0]
        : hue < 180
          ? [0, c, x]
          : hue < 240
            ? [0, x, c]
            : hue < 300
              ? [x, 0, c]
              : [c, 0, x];

  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

/** Paleta inicial, pensada para ficar boa em fita de LED. */
export const PRESET_COLORS: RGB[] = [
  { r: 255, g: 255, b: 255 },
  { r: 255, g: 0, b: 80 },
  { r: 255, g: 48, b: 0 },
  { r: 255, g: 140, b: 0 },
  { r: 255, g: 214, b: 0 },
  { r: 120, g: 255, b: 0 },
  { r: 0, g: 224, b: 110 },
  { r: 0, g: 214, b: 214 },
  { r: 0, g: 122, b: 255 },
  { r: 90, g: 60, b: 255 },
  { r: 170, g: 0, b: 255 },
  { r: 255, g: 0, b: 200 },
];

/** Gera `count` cores interpoladas ao longo de uma paleta, para previews. */
export function sampleGradient(colors: RGB[], count: number): RGB[] {
  if (colors.length === 0) return Array.from({ length: count }, () => BLACK);
  if (colors.length === 1) return Array.from({ length: count }, () => colors[0]);

  const out: RGB[] = [];
  for (let i = 0; i < count; i += 1) {
    const t = (i / Math.max(1, count - 1)) * (colors.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(colors.length - 1, lo + 1);
    const f = t - lo;
    out.push({
      r: Math.round(colors[lo].r + (colors[hi].r - colors[lo].r) * f),
      g: Math.round(colors[lo].g + (colors[hi].g - colors[lo].g) * f),
      b: Math.round(colors[lo].b + (colors[hi].b - colors[lo].b) * f),
    });
  }
  return out;
}

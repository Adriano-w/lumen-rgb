/**
 * Camada de UI sobre `EFFECT_DESCRIPTORS`.
 *
 * O que os controles mostram vem SEMPRE do descritor em shared/types.ts —
 * aqui so acrescentamos o que e puramente visual (icone) ou dependente do
 * alvo (quantos LEDs o efeito precisa para fazer sentido).
 */

import {
  Activity,
  AudioLines,
  Flame,
  Lightbulb,
  Rainbow,
  Rows3,
  ScanLine,
  Sparkle,
  Sparkles,
  Star,
  WavesHorizontal,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import {
  DEFAULT_EFFECT_PARAMS,
  EFFECT_DESCRIPTORS,
  type EffectDescriptor,
  type EffectKind,
  type EffectParams,
  type RGB,
} from '@shared/types';

/** Icone de cada efeito. Puramente decorativo, mas ajuda a varredura visual. */
export const EFFECT_ICONS: Record<EffectKind, LucideIcon> = {
  static: Lightbulb,
  breathing: Activity,
  strobe: Zap,
  'color-cycle': Sparkles,
  'rainbow-wave': WavesHorizontal,
  gradient: Rainbow,
  wave: WavesHorizontal,
  comet: Sparkle,
  scan: ScanLine,
  chase: Rows3,
  twinkle: Star,
  fire: Flame,
  alternating: Rows3,
  'audio-level': AudioLines,
  'ambient-screen': ScanLine,
};

/**
 * Efeitos espaciais: distribuem algo ao longo da fita, entao num alvo de
 * 1 LED eles nao tem o que mostrar.
 */
const SPATIAL: ReadonlySet<EffectKind> = new Set<EffectKind>([
  'rainbow-wave',
  'gradient',
  'wave',
  'comet',
  'scan',
  'chase',
  'twinkle',
  'alternating',
]);

export interface EffectUi {
  descriptor: EffectDescriptor;
  icon: LucideIcon;
  /** Precisa de 2+ LEDs no alvo. */
  spatial: boolean;
  /**
   * Tem kernel neste build. `requiresCapture` significa que o motor
   * rejeita o efeito, entao a UI nao deixa escolher.
   */
  available: boolean;
  /** Mostra a paleta? Falso quando o efeito gera as proprias cores. */
  usesPalette: boolean;
  /** Paleta e so um reforco: o efeito funciona sem nenhuma cor. */
  paletteOptional: boolean;
}

function toUi(descriptor: EffectDescriptor): EffectUi {
  return {
    descriptor,
    icon: EFFECT_ICONS[descriptor.kind],
    spatial: SPATIAL.has(descriptor.kind),
    available: !descriptor.requiresCapture,
    // `maxColors === 0` e o unico caso em que nao existe paleta nenhuma
    // (arco-iris, chama, ambiente da tela).
    usesPalette: descriptor.maxColors > 0,
    paletteOptional: descriptor.minColors === 0 && descriptor.maxColors > 0,
  };
}

/** Efeitos na ordem definida pelo motor. */
export const EFFECT_LIST: EffectUi[] = EFFECT_DESCRIPTORS.map(toUi);

const BY_KIND = new Map<EffectKind, EffectUi>(EFFECT_LIST.map((item) => [item.descriptor.kind, item]));

export function effectUi(kind: EffectKind): EffectUi {
  const found = BY_KIND.get(kind);
  if (!found) throw new Error(`Efeito desconhecido: ${kind}`);
  return found;
}

export function effectLabel(kind: EffectKind): string {
  return BY_KIND.get(kind)?.descriptor.label ?? kind;
}

/** Primeiro efeito que o motor aceita — usado como padrao seguro. */
export const DEFAULT_EFFECT_KIND: EffectKind =
  EFFECT_LIST.find((item) => item.available)?.descriptor.kind ?? 'static';

/** Cores de reserva, para um efeito nunca nascer com duas cores iguais. */
const FALLBACK_COLORS: RGB[] = [
  DEFAULT_EFFECT_PARAMS.colors[0] ?? { r: 255, g: 0, b: 80 },
  { r: 0, g: 122, b: 255 },
  { r: 255, g: 214, b: 0 },
  { r: 0, g: 224, b: 110 },
  { r: 170, g: 0, b: 255 },
  { r: 255, g: 255, b: 255 },
  { r: 0, g: 214, b: 214 },
  { r: 255, g: 48, b: 0 },
];

/**
 * Parametros iniciais de um efeito: respeita `minColors`/`maxColors` do
 * descritor e aproveita as cores que o usuario ja estava usando.
 */
export function initialParams(kind: EffectKind, seedColors: RGB[]): EffectParams {
  const { descriptor } = effectUi(kind);

  const wanted = Math.max(
    descriptor.minColors,
    Math.min(seedColors.length, descriptor.maxColors),
  );

  const colors: RGB[] = [];
  for (let i = 0; i < wanted; i += 1) {
    colors.push(seedColors[i] ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]);
  }

  return { ...DEFAULT_EFFECT_PARAMS, colors };
}

/** Prende a paleta na faixa que o efeito aceita. */
export function clampColors(kind: EffectKind, colors: RGB[]): RGB[] {
  const { descriptor } = effectUi(kind);
  if (colors.length > descriptor.maxColors) return colors.slice(0, descriptor.maxColors);
  if (colors.length >= descriptor.minColors) return colors;

  const filled = [...colors];
  while (filled.length < descriptor.minColors) {
    filled.push(FALLBACK_COLORS[filled.length % FALLBACK_COLORS.length]);
  }
  return filled;
}

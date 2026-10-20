/**
 * Regras da tela "Todos os devices".
 *
 * Tudo que essa tela aplica e um efeito do nosso motor (`mode: 'lumen'`),
 * inclusive "Cor fixa" e "Desligar" — os dois sao o efeito `static` com a
 * paleta certa. A consequencia e uma regra unica de elegibilidade: o
 * device precisa expor modo Direct, senao o motor nao tem por onde pintar.
 */

import {
  effectDescriptor,
  type Assignment,
  type Device,
  type EffectKind,
  type EffectParams,
  type RGB,
} from '@shared/types';

import { BLACK } from '@renderer/lib/color';
import { EFFECT_LIST, clampColors, type EffectUi } from '@renderer/lib/effects';

/** O que o usuario escolheu aplicar em lote. */
export type BulkMode = 'effect' | 'color' | 'off';

/**
 * Efeitos oferecidos no lote.
 *
 * `static` fica de fora: ele ja e a opcao "Cor fixa" do nivel de cima, e
 * dois caminhos para a mesma coisa so confundem.
 */
export const BULK_EFFECTS: EffectUi[] = EFFECT_LIST.filter(
  (item) => item.descriptor.kind !== 'static',
);

/** Primeiro efeito do lote que o motor realmente aceita. */
export const DEFAULT_BULK_EFFECT: EffectKind =
  BULK_EFFECTS.find((item) => item.available)?.descriptor.kind ?? 'breathing';

/** Contagem de devices em pt-BR: "1 device" / "4 devices". */
export function formatDevices(count: number): string {
  return count === 1 ? '1 device' : `${count} devices`;
}

/** Junta nomes numa frase: "A, B e C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

/** O motor so consegue pintar LED a LED onde existe modo Direct. */
export function acceptsLumen(device: Device): boolean {
  return device.supportsDirect;
}

/**
 * Efeito com movimento: reescreve os LEDs quadro a quadro.
 *
 * E o que importa para `writeWearRisk` — uma cor parada custa uma escrita
 * so, um efeito animado custa uma escrita por quadro, para sempre.
 */
export function isMovingEffect(kind: EffectKind): boolean {
  return effectDescriptor(kind)?.usesSpeed ?? false;
}

const WHITE: RGB = { r: 255, g: 255, b: 255 };

/** Cor unica atual dos parametros, com reserva para paleta vazia. */
export function singleColor(params: EffectParams): RGB {
  return params.colors[0] ?? WHITE;
}

/** Traduz a escolha da tela numa atribuicao do motor. */
export function bulkAssignment(
  mode: BulkMode,
  kind: EffectKind,
  params: EffectParams,
): Assignment {
  if (mode === 'off') {
    return {
      mode: 'lumen',
      effect: { kind: 'static', params: { ...params, colors: [BLACK], brightness: 0 } },
    };
  }

  if (mode === 'color') {
    return {
      mode: 'lumen',
      effect: { kind: 'static', params: { ...params, colors: [singleColor(params)] } },
    };
  }

  return {
    mode: 'lumen',
    effect: { kind, params: { ...params, colors: clampColors(kind, params.colors) } },
  };
}

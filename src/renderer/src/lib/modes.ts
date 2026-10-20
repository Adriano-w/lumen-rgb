/** Leitura das flags de modo do hardware e traducao para a UI. */

import { COLOR_MODE, DIRECTION, MODE_FLAG, type DeviceMode } from '@shared/types';

export const hasFlag = (flags: number, flag: number): boolean => (flags & flag) !== 0;

export const modeHasSpeed = (mode: DeviceMode): boolean =>
  hasFlag(mode.flags, MODE_FLAG.HAS_SPEED) && mode.speed !== undefined;

export const modeHasBrightness = (mode: DeviceMode): boolean =>
  hasFlag(mode.flags, MODE_FLAG.HAS_BRIGHTNESS) && mode.brightness !== undefined;

export const modeUsesColors = (mode: DeviceMode): boolean =>
  mode.colorMode !== COLOR_MODE.NONE && mode.colorsMax > 0;

export const modeIsMultiColor = (mode: DeviceMode): boolean =>
  modeUsesColors(mode) && mode.colorsMax > 1;

export const modeIsRandomColor = (mode: DeviceMode): boolean =>
  mode.colorMode === COLOR_MODE.RANDOM || hasFlag(mode.flags, MODE_FLAG.HAS_RANDOM_COLOR);

export interface DirectionOption {
  value: number;
  label: string;
  /** Nome do icone logico; o componente resolve para um lucide. */
  icon: 'left' | 'right' | 'up' | 'down' | 'horizontal' | 'vertical';
}

const LR_OPTIONS: DirectionOption[] = [
  { value: DIRECTION.LEFT, label: 'Esquerda', icon: 'left' },
  { value: DIRECTION.RIGHT, label: 'Direita', icon: 'right' },
];

const UD_OPTIONS: DirectionOption[] = [
  { value: DIRECTION.UP, label: 'Cima', icon: 'up' },
  { value: DIRECTION.DOWN, label: 'Baixo', icon: 'down' },
];

const HV_OPTIONS: DirectionOption[] = [
  { value: DIRECTION.HORIZONTAL, label: 'Horizontal', icon: 'horizontal' },
  { value: DIRECTION.VERTICAL, label: 'Vertical', icon: 'vertical' },
];

/**
 * Direcoes que o modo realmente aceita. Lista vazia = sem controle de
 * direcao, e o componente simplesmente nao aparece.
 */
export function directionOptions(mode: DeviceMode): DirectionOption[] {
  const options: DirectionOption[] = [];
  if (hasFlag(mode.flags, MODE_FLAG.HAS_DIRECTION_LR)) options.push(...LR_OPTIONS);
  if (hasFlag(mode.flags, MODE_FLAG.HAS_DIRECTION_UD)) options.push(...UD_OPTIONS);
  if (hasFlag(mode.flags, MODE_FLAG.HAS_DIRECTION_HV)) options.push(...HV_OPTIONS);
  return options;
}

export const modeHasDirection = (mode: DeviceMode): boolean => directionOptions(mode).length > 0;

/** True quando o modo salva sozinho na flash do device. */
export const modeSavesAutomatically = (mode: DeviceMode): boolean =>
  hasFlag(mode.flags, MODE_FLAG.AUTOMATIC_SAVE);

/**
 * Resumo de uma linha para o modo, em pt-BR — o que o usuario ganha ao
 * escolher ele. Evita que a lista de modos seja so jargao do firmware.
 */
export function modeSummary(mode: DeviceMode): string {
  const parts: string[] = [];

  if (mode.colorMode === COLOR_MODE.NONE) parts.push('cores automaticas');
  else if (modeIsRandomColor(mode)) parts.push('cores aleatorias');
  else if (mode.colorsMax === 1) parts.push('1 cor');
  else if (mode.colorsMin === mode.colorsMax) parts.push(`${mode.colorsMax} cores`);
  else parts.push(`${mode.colorsMin} a ${mode.colorsMax} cores`);

  if (modeHasSpeed(mode)) parts.push('velocidade');
  if (modeHasBrightness(mode)) parts.push('brilho');
  if (modeHasDirection(mode)) parts.push('direcao');

  return parts.join(' - ');
}

/** Converte um valor na faixa do modo para 0-100, para exibir ao usuario. */
export function toPercent(value: number, min: number, max: number): number {
  if (max === min) return 100;
  return Math.round(((value - min) / (max - min)) * 100);
}

/** Rotulos, icones e agrupamento por tipo de device. */

import {
  Armchair,
  Box,
  Cable,
  CircleQuestionMark,
  Component,
  Cpu,
  Fan,
  Gamepad2,
  HardDrive,
  Headphones,
  Joystick,
  Keyboard,
  Lamp,
  LayoutGrid,
  MemoryStick,
  Mic,
  Monitor,
  Mouse,
  Speaker,
  Square,
  type LucideIcon,
} from 'lucide-react';

import { DEVICE_TYPES, type Device, type DeviceType } from '@shared/types';

/** Nome do tipo em pt-BR, no plural (usado como titulo de grupo). */
export const DEVICE_TYPE_LABEL: Record<DeviceType, string> = {
  motherboard: 'Placa-mae',
  dram: 'Memoria RAM',
  gpu: 'Placa de video',
  cooler: 'Coolers',
  ledstrip: 'Fitas de LED',
  keyboard: 'Teclados',
  mouse: 'Mouses',
  mousemat: 'Mousepads',
  headset: 'Headsets',
  'headset-stand': 'Suportes de headset',
  gamepad: 'Controles',
  light: 'Luzes',
  speaker: 'Caixas de som',
  virtual: 'Virtuais',
  storage: 'Armazenamento',
  case: 'Gabinete',
  microphone: 'Microfones',
  accessory: 'Acessorios',
  keypad: 'Keypads',
  unknown: 'Outros',
};

export const DEVICE_TYPE_ICON: Record<DeviceType, LucideIcon> = {
  motherboard: Cpu,
  dram: MemoryStick,
  gpu: Monitor,
  cooler: Fan,
  ledstrip: Cable,
  keyboard: Keyboard,
  mouse: Mouse,
  mousemat: Square,
  headset: Headphones,
  'headset-stand': Armchair,
  gamepad: Gamepad2,
  light: Lamp,
  speaker: Speaker,
  virtual: Component,
  storage: HardDrive,
  case: Box,
  microphone: Mic,
  accessory: Joystick,
  keypad: LayoutGrid,
  unknown: CircleQuestionMark,
};

export function deviceIcon(type: DeviceType): LucideIcon {
  return DEVICE_TYPE_ICON[type] ?? CircleQuestionMark;
}

export function deviceTypeLabel(type: DeviceType): string {
  return DEVICE_TYPE_LABEL[type] ?? DEVICE_TYPE_LABEL.unknown;
}

/** Nome curto preferido para a lista; cai no nome bruto quando vazio. */
export function deviceLabel(device: Device): string {
  return device.displayName.trim() || device.name;
}

export interface DeviceGroup {
  type: DeviceType;
  label: string;
  devices: Device[];
}

/**
 * Agrupa devices por tipo, na ordem canonica de `DEVICE_TYPES`
 * (placa-mae primeiro, perifericos depois) e alfabetica dentro do grupo.
 */
export function groupDevicesByType(devices: Device[]): DeviceGroup[] {
  const buckets = new Map<DeviceType, Device[]>();

  for (const device of devices) {
    const list = buckets.get(device.type);
    if (list) list.push(device);
    else buckets.set(device.type, [device]);
  }

  const groups: DeviceGroup[] = [];
  for (const type of DEVICE_TYPES) {
    const list = buckets.get(type);
    if (!list || list.length === 0) continue;
    groups.push({
      type,
      label: deviceTypeLabel(type),
      devices: [...list].sort((a, b) => deviceLabel(a).localeCompare(deviceLabel(b), 'pt-BR')),
    });
  }

  return groups;
}

/** Zona selecionada, ou `undefined` quando o alvo e o device inteiro. */
export function zoneOf(device: Device, zoneIndex: number | undefined) {
  if (zoneIndex === undefined) return undefined;
  return device.zones.find((zone) => zone.index === zoneIndex);
}

/** Quantos LEDs o alvo atual cobre. */
export function targetLedCount(device: Device, zoneIndex: number | undefined): number {
  const zone = zoneOf(device, zoneIndex);
  return zone ? zone.ledsCount : device.ledCount;
}

/** Fatia de `device.colors` correspondente ao alvo. */
export function targetColors(device: Device, zoneIndex: number | undefined) {
  const zone = zoneOf(device, zoneIndex);
  if (!zone) return device.colors;
  return device.colors.slice(zone.ledOffset, zone.ledOffset + zone.ledsCount);
}

/** Chave usada para indexar atribuicoes locais por alvo. */
export function targetKey(deviceId: string, zoneIndex: number | undefined): string {
  return zoneIndex === undefined ? deviceId : `${deviceId}#${zoneIndex}`;
}

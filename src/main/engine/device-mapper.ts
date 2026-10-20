/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Traduz um `Controller` (protocolo de hardware) no `Device` que a UI consome.
 *
 * A separacao existe para que um driver so precise descrever o hardware do
 * jeito dele; normalizar para o modelo da UI — offsets de LED por zona, quais
 * controles cada modo aceita, qual modo serve ao motor de efeitos — e tarefa
 * desta camada, feita uma vez e não repetida em cada driver.
 */
import {
  COLOR_MODE,
  MODE_FLAG,
  type Device,
  type DeviceMode,
  type DeviceType,
  type DeviceZone,
} from '../../shared/types.js';
import type { Controller, ControllerMode, ControllerZone } from './hal/types.js';

function mapMode(mode: ControllerMode, index: number): DeviceMode {
  // As flags existem para a UI decidir o que mostrar. Derivamos do que o
  // driver declarou, em vez de pedir que cada driver monte o bitmask na mao.
  let flags = 0;
  if (mode.speed) flags |= MODE_FLAG.HAS_SPEED;
  if (mode.brightness) flags |= MODE_FLAG.HAS_BRIGHTNESS;
  if (mode.perLed) flags |= MODE_FLAG.HAS_PER_LED_COLOR;
  if (mode.colorsMax > 0) flags |= MODE_FLAG.HAS_MODE_SPECIFIC_COLOR;
  if (mode.directions && mode.directions.length > 0) flags |= MODE_FLAG.HAS_DIRECTION_LR;

  const mapped: DeviceMode = {
    index,
    name: mode.name,
    flags,
    colorMode: mode.perLed
      ? COLOR_MODE.PER_LED
      : mode.colorsMax > 0
        ? COLOR_MODE.MODE_SPECIFIC
        : COLOR_MODE.NONE,
    colors: [],
    colorsMin: mode.colorsMin,
    colorsMax: mode.colorsMax,
    supportsPerLed: mode.perLed,
  };

  if (mode.speed) {
    mapped.speed = { min: mode.speed.min, max: mode.speed.max, current: mode.speed.default };
  }
  if (mode.brightness) {
    mapped.brightness = {
      min: mode.brightness.min,
      max: mode.brightness.max,
      current: mode.brightness.default,
    };
  }
  if (mode.directions && mode.directions.length > 0) mapped.direction = 0;

  return mapped;
}

function mapZone(zone: ControllerZone, index: number, ledOffset: number): DeviceZone {
  const mapped: DeviceZone = {
    index,
    name: zone.name,
    type: zone.type,
    ledsCount: zone.ledCount,
    ledsMin: zone.ledsMin ?? zone.ledCount,
    ledsMax: zone.ledsMax ?? zone.ledCount,
    ledOffset,
    segments: [],
    resizable: (zone.ledsMax ?? zone.ledCount) > (zone.ledsMin ?? zone.ledCount),
  };
  return mapped;
}

export function controllerToDevice(controller: Controller, backendIndex: number): Device {
  let offset = 0;
  const zones = controller.zones.map((zone, i) => {
    const mapped = mapZone(zone, i, offset);
    offset += zone.ledCount;
    return mapped;
  });

  const modes = controller.modes.map(mapMode);

  let activeModeIndex = 0;
  try {
    activeModeIndex = controller.getActiveMode();
  } catch {
    // Nem todo hardware sabe dizer em que modo esta; 0 e um padrao seguro.
  }

  const device: Device = {
    id: controller.id,
    backend: 'hid',
    backendIndex,
    name: controller.name,
    displayName: controller.name,
    vendor: controller.vendor,
    description: controller.location,
    type: controller.type as DeviceType,
    version: controller.version,
    serial: controller.serial,
    location: controller.location,
    transport: controller.transport,
    ledCount: controller.ledCount,
    leds: controller.ledNames.map((name, index) => ({ index, name })),
    zones,
    modes,
    activeModeIndex,
    colors: [],
    supportsDirect: controller.directModeIndex !== undefined,
    writeWearRisk: controller.writeWearRisk === true,
  };

  if (controller.directModeIndex !== undefined) {
    device.directModeIndex = controller.directModeIndex;
  }

  return device;
}

/**
 * Modos de firmware que seguem animando sem o Lumen aberto, em ordem de
 * preferencia. Usado ao sair: um device deixado em modo direto congela na
 * ultima cor, porque nesse modo quem pinta e o host.
 */
const AUTONOMOUS_MODE_NAMES = [
  'Rainbow',
  'Spectrum',
  'Spectrum Cycle',
  'Color Cycle',
  'Cycling',
  'Breathing',
  'Static',
];

export function findAutonomousModeIndex(controller: Controller): number | undefined {
  for (const name of AUTONOMOUS_MODE_NAMES) {
    const index = controller.modes.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) return index;
  }
  return undefined;
}

/**
 * Backend falso do Lumen.
 *
 * Usado quando `window.lumen` nao existe — ou seja, ao abrir o renderer
 * fora do Electron (vite puro) ou antes da ponte do preload estar pronta.
 * Os devices imitam o hardware real da maquina alvo, para a UI poder ser
 * desenvolvida e verificada visualmente sem o backend.
 */

import {
  COLOR_MODE,
  DEFAULT_SETTINGS,
  MODE_FLAG,
  type Assignment,
  type Device,
  type DeviceLed,
  type DeviceMode,
  type DeviceZone,
  type Diagnostics,
  type EngineStatus,
  type LumenApi,
  type Profile,
  type RGB,
  type Settings,
  type TargetRef,
  type ZoneType,
} from '@shared/types';

/* ------------------------------------------------------------------ *
 * Fabricas                                                           *
 * ------------------------------------------------------------------ */

const rgb = (r: number, g: number, b: number): RGB => ({ r, g, b });

function makeLeds(names: string[]): DeviceLed[] {
  return names.map((name, index) => ({ index, name }));
}

interface ZoneSeed {
  name: string;
  type?: ZoneType;
  ledsCount: number;
  resizable?: boolean;
  ledLabel?: string;
}

function makeZones(seeds: ZoneSeed[]): { zones: DeviceZone[]; leds: DeviceLed[] } {
  const zones: DeviceZone[] = [];
  const ledNames: string[] = [];
  let offset = 0;

  for (const [index, seed] of seeds.entries()) {
    const type: ZoneType = seed.type ?? (seed.ledsCount > 1 ? 'linear' : 'single');
    zones.push({
      index,
      name: seed.name,
      type,
      ledsCount: seed.ledsCount,
      ledsMin: seed.resizable ? 0 : seed.ledsCount,
      ledsMax: seed.resizable ? 100 : seed.ledsCount,
      ledOffset: offset,
      segments: [],
      resizable: seed.resizable ?? false,
    });

    for (let i = 0; i < seed.ledsCount; i += 1) {
      ledNames.push(seed.ledsCount === 1 ? seed.name : `${seed.ledLabel ?? seed.name} ${i + 1}`);
    }
    offset += seed.ledsCount;
  }

  return { zones, leds: makeLeds(ledNames) };
}

interface ModeSeed {
  name: string;
  flags?: number;
  colorMode?: DeviceMode['colorMode'];
  colorsMin?: number;
  colorsMax?: number;
  colors?: RGB[];
  speed?: [min: number, max: number, current: number];
  brightness?: [min: number, max: number, current: number];
  direction?: number;
  supportsPerLed?: boolean;
}

function makeModes(seeds: ModeSeed[]): DeviceMode[] {
  return seeds.map((seed, index) => ({
    index,
    name: seed.name,
    flags: seed.flags ?? 0,
    colorMode: seed.colorMode ?? COLOR_MODE.NONE,
    speed: seed.speed ? { min: seed.speed[0], max: seed.speed[1], current: seed.speed[2] } : undefined,
    brightness: seed.brightness
      ? { min: seed.brightness[0], max: seed.brightness[1], current: seed.brightness[2] }
      : undefined,
    direction: seed.direction,
    colors: seed.colors ?? [],
    colorsMin: seed.colorsMin ?? 0,
    colorsMax: seed.colorsMax ?? 0,
    supportsPerLed: seed.supportsPerLed ?? false,
  }));
}

/** Modo "Direct" padrao: aceita cor por LED, e o que o motor do Lumen usa. */
const DIRECT_MODE: ModeSeed = {
  name: 'Direct',
  flags: MODE_FLAG.HAS_PER_LED_COLOR,
  colorMode: COLOR_MODE.PER_LED,
  supportsPerLed: true,
};

function fillColors(count: number, color: RGB): RGB[] {
  return Array.from({ length: count }, () => ({ ...color }));
}

/* ------------------------------------------------------------------ *
 * Hardware simulado                                                  *
 * ------------------------------------------------------------------ */

function makeMotherboard(): Device {
  const { zones, leds } = makeZones([
    { name: 'RGB LED 1', ledsCount: 1 },
    { name: 'Addressable Header', ledsCount: 15, resizable: true, ledLabel: 'LED' },
  ]);

  const modes = makeModes([
    DIRECT_MODE,
    {
      name: 'Static',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(255, 0, 80)],
      brightness: [0, 100, 85],
    },
    {
      name: 'Breathing',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_SPEED | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(90, 60, 255)],
      speed: [0, 5, 3],
      brightness: [0, 100, 100],
    },
    {
      name: 'Spectrum Cycle',
      flags: MODE_FLAG.HAS_SPEED | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.NONE,
      speed: [0, 5, 2],
      brightness: [0, 100, 100],
    },
    {
      name: 'Rainbow',
      flags:
        MODE_FLAG.HAS_SPEED | MODE_FLAG.HAS_DIRECTION_LR | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.NONE,
      speed: [0, 5, 3],
      brightness: [0, 100, 100],
      direction: 1,
    },
    {
      name: 'Music',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_SPEED,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 2,
      colors: [rgb(0, 214, 214), rgb(255, 0, 200)],
      speed: [0, 5, 4],
    },
  ]);

  return {
    id: 'openrgb:asrock-b450m-steel-legend',
    backend: 'openrgb',
    backendIndex: 0,
    name: 'ASRock B450M Steel Legend',
    displayName: 'B450M Steel Legend',
    vendor: 'ASRock',
    description: 'ASRock Polychrome SMBus',
    type: 'motherboard',
    version: '1.0',
    serial: '',
    location: 'SMBus 0, address 0x6A',
    transport: 'smbus',
    ledCount: leds.length,
    leds,
    zones,
    modes,
    activeModeIndex: 1,
    colors: fillColors(leds.length, rgb(255, 0, 80)),
    supportsDirect: true,
    // A placa-mae autosalva na flash a cada escrita: efeitos custam ciclos.
    writeWearRisk: true,
    directModeIndex: 0,
  };
}

function makeDram(): Device {
  const { zones, leds } = makeZones([
    { name: 'Modulo 1', ledsCount: 12, ledLabel: 'LED' },
    { name: 'Modulo 2', ledsCount: 12, ledLabel: 'LED' },
  ]);

  const modes = makeModes([
    DIRECT_MODE,
    {
      name: 'Static',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(0, 122, 255)],
      brightness: [0, 100, 100],
    },
    {
      name: 'Rainbow Wave',
      flags: MODE_FLAG.HAS_SPEED | MODE_FLAG.HAS_DIRECTION_LR | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.NONE,
      speed: [0, 4, 2],
      brightness: [0, 100, 100],
      direction: 1,
    },
    {
      name: 'Bounce',
      flags: MODE_FLAG.HAS_SPEED | MODE_FLAG.HAS_MODE_SPECIFIC_COLOR,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 4,
      colors: [rgb(255, 48, 0), rgb(255, 214, 0)],
      speed: [0, 4, 2],
    },
  ]);

  return {
    id: 'openrgb:kingston-fury-ddr4',
    backend: 'openrgb',
    backendIndex: 1,
    name: 'Kingston Fury DDR4',
    displayName: 'Fury Beast RGB (2x8GB)',
    vendor: 'Kingston',
    description: 'Kingston Fury SMBus',
    type: 'dram',
    version: '2.1',
    serial: '',
    location: 'SMBus 0, address 0x50',
    ledCount: leds.length,
    transport: 'smbus',
    leds,
    zones,
    modes,
    activeModeIndex: 2,
    colors: fillColors(leds.length, rgb(0, 122, 255)),
    supportsDirect: true,
    writeWearRisk: false,
    directModeIndex: 0,
  };
}

function makeGpu(): Device {
  const { zones, leds } = makeZones([{ name: 'GPU', ledsCount: 8, ledLabel: 'LED' }]);

  const modes = makeModes([
    DIRECT_MODE,
    {
      name: 'Static',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(170, 0, 255)],
      brightness: [0, 100, 90],
    },
    {
      name: 'Breathing',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_SPEED,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(170, 0, 255)],
      speed: [0, 10, 5],
    },
    {
      name: 'Color Cycle',
      flags: MODE_FLAG.HAS_SPEED,
      colorMode: COLOR_MODE.NONE,
      speed: [0, 10, 6],
    },
  ]);

  return {
    id: 'openrgb:gigabyte-rtx-3060',
    backend: 'openrgb',
    backendIndex: 2,
    name: 'Gigabyte RTX 3060 Gaming OC',
    displayName: 'RTX 3060 Gaming OC',
    vendor: 'Gigabyte',
    description: 'Gigabyte RGB Fusion 2 GPU',
    type: 'gpu',
    version: '',
    serial: '',
    location: 'SMBus 1, address 0x47',
    ledCount: leds.length,
    transport: 'gpu-i2c',
    leds,
    zones,
    modes,
    activeModeIndex: 1,
    colors: fillColors(leds.length, rgb(170, 0, 255)),
    writeWearRisk: false,
    supportsDirect: true,
    directModeIndex: 0,
  };
}

function makeMouse(): Device {
  const { zones, leds } = makeZones([
    { name: 'Logo', ledsCount: 1 },
    { name: 'Indicador de DPI', ledsCount: 1 },
  ]);

  const modes = makeModes([
    DIRECT_MODE,
    {
      name: 'Static',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(0, 224, 110)],
      brightness: [0, 100, 100],
    },
    {
      name: 'Cycle',
      flags: MODE_FLAG.HAS_SPEED | MODE_FLAG.HAS_BRIGHTNESS,
      colorMode: COLOR_MODE.NONE,
      speed: [1, 20, 10],
      brightness: [0, 100, 100],
    },
    {
      name: 'Breathing',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_SPEED,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(0, 224, 110)],
      speed: [1, 20, 8],
    },
  ]);

  return {
    id: 'hid:logitech-g502-hero',
    backend: 'hid',
    backendIndex: 0,
    name: 'Logitech G502 HERO',
    displayName: 'G502 HERO',
    vendor: 'Logitech',
    description: 'Logitech Lightsync (HID)',
    type: 'mouse',
    version: '',
    serial: 'LG-0A41C9',
    location: 'USB \\\\?\\hid#vid_046d&pid_c08b',
    ledCount: leds.length,
    transport: 'hid',
    leds,
    zones,
    modes,
    activeModeIndex: 1,
    writeWearRisk: false,
    colors: fillColors(leds.length, rgb(0, 224, 110)),
    supportsDirect: true,
    directModeIndex: 0,
  };
}

function makeHeadset(): Device {
  const { zones, leds } = makeZones([{ name: 'Laterais', ledsCount: 2, ledLabel: 'Lado' }]);

  const modes = makeModes([
    {
      name: 'Static',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(255, 140, 0)],
    },
    {
      name: 'Breathing',
      flags: MODE_FLAG.HAS_MODE_SPECIFIC_COLOR | MODE_FLAG.HAS_SPEED,
      colorMode: COLOR_MODE.MODE_SPECIFIC,
      colorsMin: 1,
      colorsMax: 1,
      colors: [rgb(255, 140, 0)],
      speed: [1, 10, 5],
    },
    {
      name: 'Color Cycle',
      flags: MODE_FLAG.HAS_SPEED,
      colorMode: COLOR_MODE.NONE,
      speed: [1, 10, 4],
    },
  ]);

  return {
    id: 'hid:logitech-g733',
    backend: 'hid',
    backendIndex: 1,
    name: 'Logitech G733 Lightspeed',
    displayName: 'G733 Lightspeed',
    vendor: 'Logitech',
    description: 'Logitech Lightsync sem fio (HID)',
    type: 'headset',
    version: '',
    serial: 'LG-7733BE',
    location: 'USB \\\\?\\hid#vid_046d&pid_0ab5',
    ledCount: leds.length,
    transport: 'hid',
    leds,
    zones,
    modes,
    // Headset sem modo Direct: exercita o caminho "sem efeitos do Lumen".
    writeWearRisk: false,
    activeModeIndex: 0,
    colors: fillColors(leds.length, rgb(255, 140, 0)),
    supportsDirect: false,
  };
}

/* ------------------------------------------------------------------ *
 * Implementacao                                                      *
 * ------------------------------------------------------------------ */

const nowIso = (): string => new Date().toISOString();

export function createMockApi(): LumenApi {
  let devices: Device[] = [
    makeMotherboard(),
    makeDram(),
    makeGpu(),
    makeMouse(),
    makeHeadset(),
  ];

  let settings: Settings = { ...DEFAULT_SETTINGS, theme: 'dark' };

  let profiles: Profile[] = [
    {
      id: 'profile-noite',
      name: 'Noite tranquila',
      createdAt: '2026-09-02T22:10:00.000Z',
      updatedAt: '2026-10-11T23:04:00.000Z',
      entries: [],
    },
    {
      id: 'profile-jogo',
      name: 'Modo jogo',
      createdAt: '2026-09-14T19:30:00.000Z',
      updatedAt: '2026-10-18T20:45:00.000Z',
      entries: [],
    },
    {
      id: 'profile-trabalho',
      name: 'Trabalho (branco neutro)',
      createdAt: '2026-10-01T08:00:00.000Z',
      updatedAt: '2026-10-01T08:00:00.000Z',
      entries: [],
    },
  ];

  const deviceListeners = new Set<(list: Device[]) => void>();
  const statusListeners = new Set<(status: EngineStatus) => void>();

  const emitDevices = (): void => {
    const snapshot = devices.map((device) => ({ ...device }));
    for (const listener of deviceListeners) listener(snapshot);
  };

  /** Arco-iris simples, para efeitos que geram as proprias cores. */
  const hueAt = (position: number): RGB => {
    const hue = (position * 360) % 360;
    const c = 255;
    const x = Math.round(c * (1 - Math.abs(((hue / 60) % 2) - 1)));
    if (hue < 60) return rgb(c, x, 0);
    if (hue < 120) return rgb(x, c, 0);
    if (hue < 180) return rgb(0, c, x);
    if (hue < 240) return rgb(0, x, c);
    if (hue < 300) return rgb(x, 0, c);
    return rgb(c, 0, x);
  };

  /** Repinta o alvo no estado local, para a UI refletir a mudanca. */
  const paint = (target: TargetRef, assignment: Assignment): void => {
    devices = devices.map((device) => {
      if (device.id !== target.deviceId) return device;

      const zone = target.zoneIndex === undefined ? undefined : device.zones[target.zoneIndex];
      const from = zone?.ledOffset ?? 0;
      const to = zone ? from + zone.ledsCount : device.ledCount;
      const span = Math.max(1, to - from);

      /** Cor do LED `index` sob esta atribuicao. */
      const colorAt = (index: number): RGB => {
        const palette =
          assignment.mode === 'lumen' ? assignment.effect.params.colors : assignment.colors;

        // Sem paleta, o efeito gera as cores: mostramos um arco-iris.
        if (palette.length === 0) return hueAt((index - from) / span);
        if (palette.length === 1) return { ...palette[0] };

        // Paleta de varias cores: distribui ao longo do alvo.
        const slot = Math.floor(((index - from) / span) * palette.length);
        return { ...palette[Math.min(slot, palette.length - 1)] };
      };

      const colors = device.colors.map((existing, index) =>
        index >= from && index < to ? colorAt(index) : existing,
      );

      return {
        ...device,
        colors,
        activeModeIndex:
          assignment.mode === 'lumen'
            ? (device.directModeIndex ?? device.activeModeIndex)
            : assignment.modeIndex,
      };
    });
    emitDevices();
  };

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  return {
    async getStatus() {
      await delay(120);
      return { state: 'connected', protocolVersion: 4, serverVersion: 4 };
    },

    async getDiagnostics() {
      await delay(80);
      const diagnostics: Diagnostics = {
        pawnIoInstalled: true,
        backendElevated: true,
        smbusAvailable: true,
        conflictingProcesses: [],
        failedInterfaces: [],
      };
      return diagnostics;
    },

    async listDevices() {
      await delay(260);
      return devices.map((device) => ({ ...device }));
    },

    async rescan() {
      await delay(900);
      emitDevices();
      return devices.map((device) => ({ ...device }));
    },

    async apply(target, assignment) {
      await delay(40);

      const device = devices.find((item) => item.id === target.deviceId);
      if (!device) {
        throw new Error(`Device ${target.deviceId} nao esta mais conectado.`);
      }

      // O backend de verdade recusa aqui: sem modo Direct nao existe
      // escrita LED a LED, que e como o motor do Lumen pinta. A tela de
      // lote conta com isso para nao prometer o que nao vai acontecer.
      if (assignment.mode === 'lumen' && !device.supportsDirect) {
        throw new Error('Este device nao expoe modo Direct, entao nao aceita efeitos do Lumen.');
      }

      paint(target, assignment);
    },

    async applyAll(assignment) {
      await delay(60);
      for (const device of devices) {
        paint({ deviceId: device.id }, assignment);
      }
    },

    async applyMany(deviceIds, assignment) {
      await delay(60);
      const applied: string[] = [];
      const failed: Array<{ deviceId: string; error: string }> = [];

      // Sequencial e tolerante a falha, igual ao backend real: um device
      // problematico nao pode impedir os outros de receberem o efeito.
      for (const deviceId of deviceIds) {
        try {
          paint({ deviceId }, assignment);
          applied.push(deviceId);
        } catch (err) {
          failed.push({ deviceId, error: err instanceof Error ? err.message : String(err) });
        }
      }

      return { applied, failed };
    },

    async resizeZone(deviceId, zoneIndex, ledsCount) {
      await delay(120);
      devices = devices.map((device) => {
        if (device.id !== deviceId) return device;
        const zones = device.zones.map((zone) =>
          zone.index === zoneIndex ? { ...zone, ledsCount } : zone,
        );
        const total = zones.reduce((sum, zone) => sum + zone.ledsCount, 0);
        return {
          ...device,
          zones,
          ledCount: total,
          leds: makeLeds(Array.from({ length: total }, (_, i) => `LED ${i + 1}`)),
          colors: Array.from({ length: total }, (_, i) => device.colors[i] ?? rgb(0, 0, 0)),
        };
      });
      emitDevices();
    },

    async listProfiles() {
      await delay(100);
      return profiles.map((profile) => ({ ...profile }));
    },

    async saveProfile(profile) {
      await delay(120);
      const saved: Profile = { ...profile, updatedAt: nowIso() };
      const exists = profiles.some((item) => item.id === saved.id);
      profiles = exists
        ? profiles.map((item) => (item.id === saved.id ? saved : item))
        : [...profiles, saved];
      return saved;
    },

    async loadProfile(id) {
      await delay(300);
      if (!profiles.some((profile) => profile.id === id)) {
        throw new Error(`Perfil ${id} nao encontrado.`);
      }
    },

    async deleteProfile(id) {
      await delay(120);
      profiles = profiles.filter((profile) => profile.id !== id);
    },

    async getSettings() {
      await delay(60);
      return { ...settings };
    },

    async setSettings(patch) {
      await delay(60);
      settings = { ...settings, ...patch };
      return { ...settings };
    },

    onDevicesChanged(cb) {
      deviceListeners.add(cb);
      return () => deviceListeners.delete(cb);
    },

    onStatusChanged(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
  };
}

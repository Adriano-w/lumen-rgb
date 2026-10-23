/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 *
 * Driver portado do OpenRGB (GPL-2.0-or-later), release_1.1:
 *   Controllers/KingstonFuryDRAMController/KingstonFuryDRAMController.{h,cpp}
 *   Controllers/KingstonFuryDRAMController/KingstonFuryDRAMControllerDetect.cpp
 *   Controllers/KingstonFuryDRAMController/RGBController_KingstonFuryDRAM.cpp
 * Autores originais: Geofrey Mon (geofbot) e Milan Cermak (krysmanta).
 */

/**
 * Kingston Fury DDR4 (Beast RGB) sobre SMBus.
 *
 * Cada pente responde em DOIS enderecos no mesmo barramento:
 *
 *   0x50 + slot   SPD (EEPROM JEDEC). **Somente leitura, sempre.** Escrever
 *                 ali reprograma o SPD e a maquina para de bootar.
 *   0x58 + slot   controlador RGB. E aqui que escrevemos.
 *
 * O controlador RGB nao e um dispositivo SMBus bem comportado: leituras saem
 * por `read_word_data` e o byte util e o ALTO da palavra. Escritas sao
 * `write_byte_data` comuns.
 *
 * Toda alteracao acontece dentro de uma transacao:
 *
 *   escreve 0x08 = 0x53   ("begin")
 *   ... escreve os registradores que mudaram ...
 *   escreve 0x08 = 0x44   ("apply") — so entao o firmware aplica
 *
 * Mapa de registradores (iguais em todos os pentes):
 *
 *   0x01..0x04  leitura: assinatura "FURY", um caractere por registrador
 *   0x06        leitura: codigo do modelo (0x21/0x23 = Beast DDR4)
 *   0x08        begin/apply
 *   0x09        modo
 *   0x0B        indice do pente — SEMPRE 0. Valor diferente trava o modulo.
 *   0x0C        direcao: 0x01 de baixo para cima, 0x02 de cima para baixo
 *   0x0D        "delay" — parametro por modo, nao e atraso de barramento
 *   0x0E        velocidade
 *   0x12..0x1D  parametros de Dynamic e Breath
 *   0x20        brilho global (0-100)
 *   0x23..0x25  cor de fundo (R, G, B) dos modos que tem fundo
 *   0x26        "length" — parametro por modo
 *   0x27        quantos pentes participam do efeito (maximo 4)
 *   0x30        quantas cores o modo usa
 *   0x31+3n     cor n do modo: R em 0x31+3n, G em 0x32+3n, B em 0x33+3n
 *   0x50+3n     LED n no modo Direct: R em 0x50+3n, G em 0x51+3n, B em 0x52+3n
 *
 * **Economia de barramento.** O firmware e lento e exige ~10 ms depois de cada
 * grupo de escritas. Por isso mantemos um cache por pente de tudo que ja foi
 * escrito e so mandamos registrador que realmente mudou — exatamente como o
 * OpenRGB faz. Uma cena parada custa duas transacoes (begin/apply) e nada
 * mais; um refresh completo do modo Direct custa ~30 escritas por pente.
 *
 * O device **nao** persiste nada: ao desligar volta ao efeito padrao. Por isso
 * nao ha `save()` aqui.
 */
import type { RGB } from '../../../shared/types.js';
import type {
  Controller,
  ControllerDetector,
  ControllerMode,
  ControllerZone,
  DetectionContext,
  SetModeOptions,
  SmbusBus,
} from '../hal/types.js';
import { sleepSync } from '../hal/timing.js';

/* ------------------------------------------------------------------ *
 * Protocolo                                                          *
 * ------------------------------------------------------------------ */

/** Base do controlador RGB; o endereco real e base + indice do slot. */
const FURY_BASE_ADDR_DDR4 = 0x58;

/** Base do SPD. Lemos para confirmar que ha um DDR4 no slot. NUNCA escrevemos. */
const SPD_BASE_ADDR = 0x50;

/** Slots DDR4 enderecaveis pelo esquema 0x58+n. */
const MAX_SLOTS = 4;

const LEDS_PER_DIMM = 10;

/** Pausa que o firmware exige depois de um grupo de escritas. */
const FURY_DELAY_MS = 10;

/** Quantas cores de modo o firmware aceita. */
const MAX_MODE_COLORS = 10;

/** Byte do SPD DDR4 que diz o tipo de memoria, e o valor esperado. */
const SPD_REG_MEMORY_TYPE = 0x02;
const SPD_TYPE_DDR4 = 0x0c;

const REG = {
  MODEL: 0x06,
  APPLY: 0x08,
  MODE: 0x09,
  INDEX: 0x0b,
  DIRECTION: 0x0c,
  DELAY: 0x0d,
  SPEED: 0x0e,
  DYNAMIC_HOLD_A: 0x12,
  DYNAMIC_HOLD_B: 0x13,
  DYNAMIC_FADE_A: 0x14,
  DYNAMIC_FADE_B: 0x15,
  BREATH_MIN_TO_MID: 0x16,
  BREATH_MID_TO_MAX: 0x17,
  BREATH_MAX_TO_MID: 0x18,
  BREATH_MID_TO_MIN: 0x19,
  BREATH_MIN_HOLD: 0x1a,
  BREATH_MAX_BRIGHTNESS: 0x1b,
  BREATH_MID_BRIGHTNESS: 0x1c,
  BREATH_MIN_BRIGHTNESS: 0x1d,
  BRIGHTNESS: 0x20,
  BG_RED: 0x23,
  BG_GREEN: 0x24,
  BG_BLUE: 0x25,
  LENGTH: 0x26,
  NUM_SLOTS: 0x27,
  NUM_COLORS: 0x30,
  MODE_BASE_RED: 0x31,
  MODE_BASE_GREEN: 0x32,
  MODE_BASE_BLUE: 0x33,
  BASE_RED: 0x50,
  BASE_GREEN: 0x51,
  BASE_BLUE: 0x52,
} as const;

const TRANSFER = {
  BEGIN: 0x53,
  END: 0x44,
} as const;

/** Codigos de modelo DDR4 que este protocolo atende. */
const MODEL_BEAST_WHITE_DDR4 = 0x21;
const MODEL_BEAST_DDR4 = 0x23;

const DIRECTION_BOTTOM_TO_TOP = 0x01;
const DIRECTION_TOP_TO_BOTTOM = 0x02;

/**
 * Valores de modo.
 *
 * Varios modos compartilham o MESMO byte no registrador 0x09 e so se
 * distinguem pelos parametros auxiliares (delay, length, direcao). O OpenRGB
 * resolve isso guardando um discriminador no byte ALTO; mantemos a convencao:
 * o que vai para o fio e `value & 0xFF`.
 */
const MODE_VALUE = {
  STATIC: 0x000,
  RAINBOW: 0x001,
  SPECTRUM: 0x101,
  RHYTHM: 0x002,
  BREATH: 0x003,
  DYNAMIC: 0x004,
  SLIDE: 0x005,
  SLITHER: 0x105,
  TELEPORT: 0x205,
  WIND: 0x305,
  COMET: 0x006,
  RAIN: 0x106,
  FIREWORK: 0x206,
  VOLTAGE: 0x007,
  FLAME: 0x009,
  TWILIGHT: 0x00a,
  FURY: 0x00b,
  DIRECT: 0x010,
  PRISM: 0x011,
} as const;

/** `directions[0]` = de baixo para cima, `directions[1]` = de cima para baixo. */
const DIRECTIONS = ['Up', 'Down'] as const;
const DIR_UP = 0;
const DIR_DOWN = 1;

/**
 * Pentes alternados sobem e descem — e o que da o efeito de "cobra" entre
 * modulos nos modos Slither e Teleport.
 */
function alternatingDirections(slotCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < slotCount; i++) {
    out.push(i % 2 === 0 ? DIRECTION_BOTTOM_TO_TOP : DIRECTION_TOP_TO_BOTTOM);
  }
  return out;
}

/** Parametros fixos que cada modo exige, alem do que o usuario escolhe. */
interface FuryModeSpec extends ControllerMode {
  /** Valor de `REG.DELAY`, quando o modo exige um. */
  delay?: number;
  /** Valor de `REG.LENGTH`, quando o modo exige um. */
  length?: number;
  /** Direcao fixa, escrita antes da escolha do usuario. */
  fixedDirection?: number;
  /** O modo usa direcoes alternadas entre pentes. */
  alternatingDirection?: boolean;
  /** A ULTIMA cor da paleta e a cor de fundo, nao uma cor do efeito. */
  hasBackgroundColor?: boolean;
  /** Direcao escolhida quando quem chama nao informa nenhuma. */
  defaultDirection?: number;
}

/** Paleta padrao do OpenRGB, usada quando o modo exige cores e nenhuma vem. */
const DEFAULT_COLORS: readonly RGB[] = [
  { r: 0xff, g: 0x00, b: 0x00 },
  { r: 0x00, g: 0xff, b: 0x00 },
  { r: 0xff, g: 0x64, b: 0x00 },
  { r: 0x00, g: 0x00, b: 0xff },
  { r: 0xef, g: 0xef, b: 0x00 },
  { r: 0x80, g: 0x00, b: 0x80 },
  { r: 0x00, g: 0x6d, b: 0x77 },
  { r: 0xff, g: 0xc8, b: 0x00 },
  { r: 0xff, g: 0x55, b: 0xff },
  { r: 0x3c, g: 0x7d, b: 0xff },
];

/** Cor de fundo padrao dos modos que tem fundo. */
const DEFAULT_BACKGROUND: RGB = { r: 16, g: 16, b: 16 };

const BRIGHTNESS = { min: 0, max: 100, default: 80 } as const;

/**
 * Tabela de modos, na ordem da UI. Direct e o primeiro — e o unico que aceita
 * cor por LED e o que o motor de efeitos do Lumen usa.
 *
 * Como no Polychrome, `speed.min` e o mais LENTO e `speed.max` o mais RAPIDO,
 * e no fio o rapido e o numero menor: varios modos tem `min > max`. Numeros
 * crus do OpenRGB, sem traducao.
 */
const MODES: readonly FuryModeSpec[] = [
  {
    name: 'Direct',
    value: MODE_VALUE.DIRECT,
    perLed: true,
    colorsMin: 0,
    colorsMax: 0,
    brightness: BRIGHTNESS,
  },
  {
    name: 'Static',
    value: MODE_VALUE.STATIC,
    perLed: false,
    colorsMin: 1,
    colorsMax: 1,
    brightness: BRIGHTNESS,
    fixedDirection: DIRECTION_BOTTOM_TO_TOP,
    delay: 0,
  },
  {
    name: 'Rainbow',
    value: MODE_VALUE.RAINBOW,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 60, max: 0, default: 25 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 0,
  },
  {
    name: 'Spectrum',
    value: MODE_VALUE.SPECTRUM,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 60, max: 0, default: 25 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 4,
  },
  {
    name: 'Rhythm',
    value: MODE_VALUE.RHYTHM,
    perLed: false,
    colorsMin: 2,
    colorsMax: 11,
    speed: { min: 10, max: 0, default: 0 },
    brightness: BRIGHTNESS,
    fixedDirection: DIRECTION_BOTTOM_TO_TOP,
    delay: 3,
    hasBackgroundColor: true,
  },
  {
    name: 'Breath',
    value: MODE_VALUE.BREATH,
    perLed: false,
    colorsMin: 1,
    colorsMax: 10,
    speed: { min: 10, max: 1, default: 5 },
    brightness: BRIGHTNESS,
    fixedDirection: DIRECTION_BOTTOM_TO_TOP,
    delay: 0,
  },
  {
    name: 'Dynamic',
    value: MODE_VALUE.DYNAMIC,
    perLed: false,
    colorsMin: 1,
    colorsMax: 10,
    speed: { min: 1000, max: 100, default: 300 },
    brightness: BRIGHTNESS,
    fixedDirection: DIRECTION_BOTTOM_TO_TOP,
    delay: 0,
  },
  {
    name: 'Slide',
    value: MODE_VALUE.SLIDE,
    perLed: false,
    colorsMin: 2,
    colorsMax: 11,
    speed: { min: 255, max: 0, default: 8 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 3,
    length: 4,
    hasBackgroundColor: true,
  },
  {
    name: 'Slither',
    value: MODE_VALUE.SLITHER,
    perLed: false,
    colorsMin: 2,
    colorsMax: 11,
    speed: { min: 255, max: 0, default: 40 },
    brightness: BRIGHTNESS,
    delay: 12,
    length: 12,
    alternatingDirection: true,
    hasBackgroundColor: true,
  },
  {
    name: 'Teleport',
    value: MODE_VALUE.TELEPORT,
    perLed: false,
    colorsMin: 2,
    colorsMax: 11,
    speed: { min: 255, max: 0, default: 8 },
    brightness: BRIGHTNESS,
    delay: 0,
    length: 3,
    alternatingDirection: true,
    hasBackgroundColor: true,
  },
  {
    name: 'Wind',
    value: MODE_VALUE.WIND,
    perLed: false,
    colorsMin: 2,
    colorsMax: 11,
    speed: { min: 255, max: 0, default: 8 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 0,
    length: 12,
    hasBackgroundColor: true,
  },
  {
    name: 'Comet',
    value: MODE_VALUE.COMET,
    perLed: false,
    colorsMin: 1,
    colorsMax: 10,
    speed: { min: 255, max: 0, default: 25 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 0,
    length: 7,
  },
  {
    name: 'Rain',
    value: MODE_VALUE.RAIN,
    perLed: false,
    colorsMin: 1,
    colorsMax: 10,
    speed: { min: 28, max: 8, default: 25 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_DOWN,
    delay: 0,
    length: 3,
  },
  {
    name: 'Firework',
    value: MODE_VALUE.FIREWORK,
    perLed: false,
    colorsMin: 1,
    colorsMax: 10,
    speed: { min: 83, max: 33, default: 33 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 0,
    length: 7,
  },
  {
    name: 'Voltage',
    value: MODE_VALUE.VOLTAGE,
    perLed: false,
    colorsMin: 2,
    colorsMax: 11,
    speed: { min: 18, max: 5, default: 16 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 0,
    hasBackgroundColor: true,
  },
  {
    name: 'Flame',
    value: MODE_VALUE.FLAME,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 64, max: 40, default: 64 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 0,
  },
  {
    name: 'Twilight',
    value: MODE_VALUE.TWILIGHT,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 255, max: 0, default: 64 },
    brightness: BRIGHTNESS,
    delay: 0,
  },
  {
    name: 'Fury',
    value: MODE_VALUE.FURY,
    perLed: false,
    colorsMin: 2,
    colorsMax: 11,
    speed: { min: 255, max: 0, default: 76 },
    brightness: BRIGHTNESS,
    directions: DIRECTIONS,
    defaultDirection: DIR_UP,
    delay: 0,
    hasBackgroundColor: true,
  },
  {
    name: 'Prism',
    value: MODE_VALUE.PRISM,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 60, max: 0, default: 40 },
    brightness: BRIGHTNESS,
    delay: 2,
  },
];

const DIRECT_MODE_INDEX = MODES.findIndex((m) => m.value === MODE_VALUE.DIRECT);

/** Deslocamentos de velocidade por pente, copiados do software da Kingston. */
const RAIN_SPEED_OFFSETS = [11, 0, 15, 9] as const;
const FIREWORK_SPEED_OFFSETS = [15, 0, 19, 4] as const;

/* ------------------------------------------------------------------ *
 * Utilitarios                                                        *
 * ------------------------------------------------------------------ */

function toByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value) & 0xff;
}

/** Clampeia respeitando faixas invertidas (`min > max`, comum aqui). */
function clampToRange(value: number, a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return Math.max(lo, Math.min(hi, Math.round(value)));
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hex2(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Controller                                                         *
 * ------------------------------------------------------------------ */

interface FuryInfo {
  bus: SmbusBus;
  /** Indices de slot ocupados (0 = 0x58, 1 = 0x59, ...). */
  slots: readonly number[];
  /** Codigo de modelo lido do primeiro pente. */
  modelCode: number;
  /** Modo lido do device na deteccao, em valor de fio (byte baixo). */
  activeModeValue: number;
}

function modelName(code: number): string {
  switch (code) {
    case MODEL_BEAST_DDR4:
      return 'Kingston Fury Beast DDR4';
    case MODEL_BEAST_WHITE_DDR4:
      return 'Kingston Fury Beast White DDR4';
    default:
      return 'Kingston Fury DDR4';
  }
}

class KingstonFuryController implements Controller {
  readonly id: string;
  readonly name: string;
  readonly vendor = 'Kingston';
  readonly type = 'dram' as const;
  readonly location: string;
  /** Memoria por SMBus, no mesmo barramento do SPD dos modulos. */
  readonly transport = 'smbus' as const;
  readonly version = '';
  readonly serial = '';

  readonly zones: readonly ControllerZone[];
  readonly modes: readonly ControllerMode[] = MODES;
  readonly ledCount: number;
  readonly ledNames: readonly string[];
  readonly directModeIndex = DIRECT_MODE_INDEX;

  private readonly bus: SmbusBus;
  private readonly slots: readonly number[];

  /**
   * Cache do que ja esta escrito em cada pente. O firmware e lento e cada
   * grupo de escritas custa 10 ms: so mandamos o que mudou de verdade.
   */
  private readonly regCache: Array<Map<number, number>>;

  private activeMode: number;
  /** Cores por LED do modo Direct. */
  private readonly ledColors: RGB[];
  /** Parametros do modo ativo, lembrados entre chamadas. */
  private modeSpeed: number;
  private modeBrightness: number;
  private modeDirection: number;
  private modeColors: RGB[];

  constructor(info: FuryInfo) {
    this.bus = info.bus;
    this.slots = info.slots;
    this.regCache = info.slots.map(() => new Map<number, number>());

    const addresses = info.slots.map((slot) => FURY_BASE_ADDR_DDR4 + slot);
    this.name = modelName(info.modelCode);
    this.id = `kingston-fury:${slug(info.bus.name)}:${addresses
      .map((a) => a.toString(16))
      .join('-')}`;
    this.location = `${info.bus.name}, addresses ${addresses.map(hex2).join(', ')}`;

    const zones: ControllerZone[] = [];
    const ledNames: string[] = [];

    for (let slotIdx = 0; slotIdx < info.slots.length; slotIdx++) {
      const zoneName = `Fury Slot ${slotIdx + 1}`;
      zones.push({
        name: zoneName,
        type: 'linear',
        ledCount: LEDS_PER_DIMM,
        ledsMin: LEDS_PER_DIMM,
        ledsMax: LEDS_PER_DIMM,
      });
      for (let ledIdx = 0; ledIdx < LEDS_PER_DIMM; ledIdx++) {
        ledNames.push(`${zoneName}, LED ${ledIdx + 1}`);
      }
    }

    this.zones = zones;
    this.ledNames = ledNames;
    this.ledCount = ledNames.length;
    this.ledColors = ledNames.map(() => ({ ...DEFAULT_COLORS[0]! }));

    const modeIdx = MODES.findIndex((m) => (m.value & 0xff) === info.activeModeValue);
    this.activeMode = modeIdx >= 0 ? modeIdx : DIRECT_MODE_INDEX;

    const mode = MODES[this.activeMode]!;
    this.modeSpeed = mode.speed?.default ?? 0;
    this.modeBrightness = mode.brightness?.default ?? BRIGHTNESS.default;
    this.modeDirection = mode.defaultDirection ?? DIR_UP;
    this.modeColors = defaultPaletteFor(mode);
  }

  getActiveMode(): number {
    return this.activeMode;
  }

  setMode(modeIndex: number, options: SetModeOptions): void {
    const mode = MODES[modeIndex];
    if (!mode) {
      throw new Error(`modo ${modeIndex} nao existe no Kingston Fury`);
    }

    this.activeMode = modeIndex;

    this.modeSpeed =
      mode.speed === undefined
        ? 0
        : clampToRange(options.speed ?? mode.speed.default, mode.speed.min, mode.speed.max);

    this.modeBrightness =
      mode.brightness === undefined
        ? BRIGHTNESS.default
        : clampToRange(
            options.brightness ?? mode.brightness.default,
            mode.brightness.min,
            mode.brightness.max,
          );

    this.modeDirection =
      options.direction !== undefined && options.direction >= 0 && options.direction <= 1
        ? options.direction
        : (mode.defaultDirection ?? DIR_UP);

    this.modeColors =
      options.colors && options.colors.length > 0
        ? normalizePalette(mode, options.colors)
        : defaultPaletteFor(mode);

    // O preambulo roda SEMPRE, mesmo quando o modo pedido ja e o atual.
    //
    // A versao anterior o pulava nesse caso, por economia. Parecia seguro e
    // nao era: o driver nao e o unico que escreve nesses registradores. Um
    // diagnostico, outra aplicacao, ou uma sessao anterior com configuracao
    // diferente deixam estado que ele desconhece — e entao "o modo ja e esse,
    // nao preciso fazer nada" conclui errado.
    //
    // Aconteceu de verdade: um indice de pente invalido ficou gravado, travou
    // o modulo numa cor fixa, e NENHUM restore subsequente corrigiu, porque o
    // modo nunca mudava e o preambulo nunca rodava. Levou varias rodadas de
    // diagnostico para achar, justamente porque o sintoma sobrevivia ao que
    // deveria ser a correcao.
    //
    // `setMode` e uma ordem explicita — "coloque este device neste modo". Ela
    // deve ESTABELECER o estado, nao presumi-lo. Custa duas escritas por pente.
    this.sendPreamble();

    this.applyAll();
  }

  updateLeds(colors: readonly RGB[]): void {
    const count = Math.min(colors.length, this.ledCount);
    for (let i = 0; i < count; i++) {
      this.ledColors[i] = colors[i]!;
    }
    this.applyAll();
  }

  updateZoneLeds(zoneIndex: number, colors: readonly RGB[]): void {
    if (zoneIndex < 0 || zoneIndex >= this.zones.length) {
      throw new Error(`zona ${zoneIndex} nao existe no Kingston Fury`);
    }
    const offset = zoneIndex * LEDS_PER_DIMM;
    const count = Math.min(colors.length, LEDS_PER_DIMM);
    for (let i = 0; i < count; i++) {
      this.ledColors[offset + i] = colors[i]!;
    }
    this.applyAll();
  }

  close(): void {
    // Nada a liberar: o barramento SMBus e do HAL, nao nosso.
  }

  /* ---------------------------------------------------------------- *
   * Programacao do device                                            *
   * ---------------------------------------------------------------- */

  /**
   * Reescreve o estado inteiro dentro de uma transacao.
   *
   * Parece caro e nao e: o cache de registradores faz com que, numa cena
   * parada, isto custe apenas as duas escritas de begin/apply. E o mesmo
   * desenho do OpenRGB, e e o que garante que o firmware nunca fica num
   * estado meio-programado.
   */
  private applyAll(): void {
    const mode = MODES[this.activeMode]!;

    this.sendBegin();

    this.setRegister(REG.MODE, mode.value & 0xff);

    /*-------------------------------------------------------------*\
    | Parametros fixos do modo. Varios modos compartilham o mesmo   |
    | byte em 0x09 e e exatamente isto que os diferencia.           |
    \*-------------------------------------------------------------*/
    if (mode.fixedDirection !== undefined) {
      this.setRegister(REG.DIRECTION, mode.fixedDirection);
    }
    if (mode.alternatingDirection) {
      this.setRegisterPerSlot(REG.DIRECTION, alternatingDirections(this.slots.length));
    }
    if (mode.delay !== undefined) {
      this.setRegister(REG.DELAY, mode.delay);
    }
    if (mode.length !== undefined) {
      this.setRegister(REG.LENGTH, mode.length);
    }
    if (mode.value === MODE_VALUE.STATIC) {
      // Static zera a velocidade explicitamente; sem isso o firmware herda a
      // do efeito anterior e pisca.
      this.setRegister(REG.SPEED, 0);
    }

    /*-------------------------------------------------------------*\
    | Cores                                                         |
    \*-------------------------------------------------------------*/
    if (mode.perLed) {
      this.writeLedColors();
    } else if (mode.colorsMax > 0) {
      if (mode.hasBackgroundColor) {
        const background = this.modeColors[this.modeColors.length - 1] ?? DEFAULT_BACKGROUND;
        this.writeModeColors(this.modeColors.slice(0, -1));
        this.setRegister(REG.BG_RED, toByte(background.r));
        this.setRegister(REG.BG_GREEN, toByte(background.g));
        this.setRegister(REG.BG_BLUE, toByte(background.b));
      } else {
        this.writeModeColors(this.modeColors);
      }
    }

    /*-------------------------------------------------------------*\
    | Direcao escolhida pelo usuario (sobrepoe a fixa, de proposito)|
    \*-------------------------------------------------------------*/
    if (mode.directions && mode.directions.length > 0) {
      this.setRegister(
        REG.DIRECTION,
        this.modeDirection === DIR_DOWN ? DIRECTION_TOP_TO_BOTTOM : DIRECTION_BOTTOM_TO_TOP,
      );
    }

    /*-------------------------------------------------------------*\
    | Velocidade — cada familia de modo codifica de um jeito        |
    \*-------------------------------------------------------------*/
    if (mode.speed) {
      this.writeSpeed(mode);
    }

    this.setRegister(REG.BRIGHTNESS, this.modeBrightness);

    // O firmware so sincroniza efeito entre no maximo 4 pentes.
    this.setRegister(REG.NUM_SLOTS, Math.min(this.slots.length, 4));

    this.sendApply();
  }

  private writeSpeed(mode: FuryModeSpec): void {
    const speed = this.modeSpeed;

    switch (mode.value) {
      case MODE_VALUE.DYNAMIC: {
        this.setRegister(REG.SPEED, 0);
        // Tempo segurando a cor e tempo de transicao, ambos em unidades de
        // 256; o registrador "_B" e so um "o tempo acima e diferente de zero".
        this.setRegister(REG.DYNAMIC_HOLD_A, speed >> 8);
        this.setRegister(REG.DYNAMIC_HOLD_B, 1);
        this.setRegister(REG.DYNAMIC_FADE_A, (speed * 5) >> 8);
        this.setRegister(REG.DYNAMIC_FADE_B, 1);
        break;
      }

      case MODE_VALUE.BREATH: {
        this.setRegister(REG.SPEED, 0);
        // Os quatro trechos da respiracao, nos tempos que o software da
        // Kingston usa. Os valores saturam em 1 byte, como no original.
        this.setRegister(REG.BREATH_MIN_TO_MID, speed * 3);
        this.setRegister(REG.BREATH_MID_TO_MAX, speed);
        this.setRegister(REG.BREATH_MAX_TO_MID, speed);
        this.setRegister(REG.BREATH_MID_TO_MIN, speed * 3);
        this.setRegister(REG.BREATH_MIN_HOLD, 1);
        this.setRegister(REG.BREATH_MAX_BRIGHTNESS, 100);
        this.setRegister(REG.BREATH_MID_BRIGHTNESS, 64);
        this.setRegister(REG.BREATH_MIN_BRIGHTNESS, 0);
        break;
      }

      case MODE_VALUE.RAIN:
        this.setRegisterPerSlot(REG.SPEED, this.offsetSpeeds(RAIN_SPEED_OFFSETS));
        break;

      case MODE_VALUE.FIREWORK:
        this.setRegisterPerSlot(REG.SPEED, this.offsetSpeeds(FIREWORK_SPEED_OFFSETS));
        break;

      default:
        this.setRegister(REG.SPEED, speed);
        break;
    }
  }

  /** Dessincroniza os pentes somando um deslocamento por posicao. */
  private offsetSpeeds(offsets: readonly number[]): number[] {
    return this.slots.map((_slot, idx) => this.modeSpeed + (offsets[idx % offsets.length] ?? 0));
  }

  private writeModeColors(colors: readonly RGB[]): void {
    if (colors.length === 0) return;
    const used = colors.slice(0, MAX_MODE_COLORS);

    this.setRegister(REG.NUM_COLORS, used.length);
    for (let i = 0; i < used.length; i++) {
      const color = used[i]!;
      this.setRegister(REG.MODE_BASE_RED + i * 3, toByte(color.r));
      this.setRegister(REG.MODE_BASE_GREEN + i * 3, toByte(color.g));
      this.setRegister(REG.MODE_BASE_BLUE + i * 3, toByte(color.b));
    }
  }

  /**
   * Escreve as cores do modo Direct.
   *
   * Percorre por LED e nao por pente: assim os dois pentes recebem o mesmo
   * registrador em sequencia e pagamos UMA pausa de 10 ms para os dois, em vez
   * de uma por pente. Ordem R, B, G e a do OpenRGB — preservada de proposito.
   */
  /**
   * Escreve as cores por LED.
   *
   * As 30 escritas (10 LEDs x 3 canais) sao UM grupo, com uma pausa so no
   * fim. A versao anterior pausava apos cada registrador: com a granularidade
   * do temporizador do Windows, os 10ms pedidos viravam ~15,6 reais, e 30
   * deles custavam ~470ms — medido. Um quadro da memoria saia por 536ms, mais
   * caro que a placa-mae com 103 LEDs.
   *
   * O firmware pede respiro entre GRUPOS de escrita, nao entre registradores;
   * a transacao aberta (begin/apply) ja o protege de ler estado parcial.
   */
  private writeLedColors(): void {
    let wrote = false;

    for (let ledIdx = 0; ledIdx < LEDS_PER_DIMM; ledIdx++) {
      for (let slotIdx = 0; slotIdx < this.slots.length; slotIdx++) {
        const color = this.ledColors[slotIdx * LEDS_PER_DIMM + ledIdx] ?? { r: 0, g: 0, b: 0 };
        // Ordem R, B, G — e a que o firmware espera, nao engano.
        wrote = this.cachedWrite(slotIdx, REG.BASE_RED + ledIdx * 3, toByte(color.r)) || wrote;
        wrote = this.cachedWrite(slotIdx, REG.BASE_BLUE + ledIdx * 3, toByte(color.b)) || wrote;
        wrote = this.cachedWrite(slotIdx, REG.BASE_GREEN + ledIdx * 3, toByte(color.g)) || wrote;
      }
    }

    if (wrote) sleepSync(FURY_DELAY_MS);
  }

  /* ---------------------------------------------------------------- *
   * Transacoes e escrita crua                                        *
   * ---------------------------------------------------------------- */

  private sendBegin(): void {
    for (let idx = 0; idx < this.slots.length; idx++) {
      this.rawWrite(idx, REG.APPLY, TRANSFER.BEGIN);
    }
    sleepSync(FURY_DELAY_MS);
  }

  private sendApply(): void {
    for (let idx = 0; idx < this.slots.length; idx++) {
      this.rawWrite(idx, REG.APPLY, TRANSFER.END);
    }
    sleepSync(FURY_DELAY_MS);
  }

  /**
   * Zera o indice de todos os pentes e diz ao firmware quantos existem.
   *
   * **Nao tente escrever a posicao fisica em 0x0B.** A tentacao e obvia — o
   * registrador existe, se chama "indice do pente", e encadear o efeito entre
   * modulos e exatamente o que se quer. Testado nesta maquina, com APPLY
   * separado e com os dois APPLY a 1ms de distancia: escrever indice diferente
   * de zero **TRAVA aquele modulo numa cor fixa**. Reproduzivel.
   *
   * Com ambos em zero, os dois pentes animam. Eles nao ficam em fase um com o
   * outro — cada controlador parte do proprio relogio, e como as transacoes
   * sao obrigatoriamente sequenciais (o firmware recusa duas abertas ao mesmo
   * tempo, com 0x800701B1) nao ha como dispara-los juntos.
   *
   * Ou seja: **sincronia entre os pentes nao existe em modo de firmware.**
   * Quem quiser as memorias em fase — entre si ou com o resto da maquina —
   * precisa usar um efeito do Lumen, que pinta cada LED a partir de uma origem
   * de tempo unica. O NUM_SLOTS continua sendo escrito porque informa o
   * firmware do conjunto; so nao resolve a fase.
   */
  private sendPreamble(): void {
    this.sendBegin();
    for (let idx = 0; idx < this.slots.length; idx++) {
      this.rawWrite(idx, REG.INDEX, 0);
      this.rawWrite(idx, REG.NUM_SLOTS, Math.min(this.slots.length, 4));
    }
    sleepSync(FURY_DELAY_MS);
    this.sendApply();
  }

  /** Mesmo valor em todos os pentes. */
  private setRegister(reg: number, value: number): void {
    let wrote = false;
    for (let idx = 0; idx < this.slots.length; idx++) {
      wrote = this.cachedWrite(idx, reg, toByte(value)) || wrote;
    }
    if (wrote) sleepSync(FURY_DELAY_MS);
  }

  /** Um valor por pente. Uma pausa so para o grupo todo. */
  private setRegisterPerSlot(reg: number, values: readonly number[]): void {
    let wrote = false;
    for (let idx = 0; idx < this.slots.length; idx++) {
      wrote = this.cachedWrite(idx, reg, toByte(values[idx] ?? 0)) || wrote;
    }
    if (wrote) sleepSync(FURY_DELAY_MS);
  }

  /** Devolve true quando a escrita realmente aconteceu no barramento. */
  private cachedWrite(slotIdx: number, reg: number, value: number): boolean {
    const cache = this.regCache[slotIdx];
    if (cache && cache.get(reg) === value) return false;

    if (this.rawWrite(slotIdx, reg, value)) {
      cache?.set(reg, value);
      return true;
    }

    // A escrita falhou: esquece o valor para nao mentir no proximo refresh.
    cache?.delete(reg);
    return false;
  }

  private rawWrite(slotIdx: number, reg: number, value: number): boolean {
    const address = FURY_BASE_ADDR_DDR4 + (this.slots[slotIdx] ?? 0);

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        this.bus.writeByteData(address, reg, value & 0xff);
        return true;
      } catch {
        // O controlador NAKa quando esta ocupado. Recuo crescente, igual ao
        // OpenRGB: 30 ms, 60 ms, 90 ms...
        sleepSync(3 * attempt * FURY_DELAY_MS);
      }
    }
    return false;
  }
}

/** Paleta inicial de um modo: a do OpenRGB, mais o fundo quando ele existe. */
function defaultPaletteFor(mode: FuryModeSpec): RGB[] {
  if (mode.colorsMax <= 0) return [];

  const wanted = mode.hasBackgroundColor ? mode.colorsMax - 1 : mode.colorsMax;
  const palette = DEFAULT_COLORS.slice(0, Math.min(wanted, DEFAULT_COLORS.length)).map((c) => ({
    ...c,
  }));

  if (mode.hasBackgroundColor) palette.push({ ...DEFAULT_BACKGROUND });
  return palette;
}

/**
 * Ajusta a paleta recebida ao que o modo aceita.
 *
 * Modos com fundo exigem pelo menos duas cores: as do efeito mais a ultima,
 * que e o fundo. Quando vem menos do que o minimo, completamos repetindo.
 */
function normalizePalette(mode: FuryModeSpec, colors: readonly RGB[]): RGB[] {
  if (mode.colorsMax <= 0) return [];

  const out = colors.slice(0, mode.colorsMax).map((c) => ({ ...c }));
  while (out.length < mode.colorsMin) {
    out.push({ ...(colors[out.length % colors.length] ?? DEFAULT_COLORS[0]!) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Deteccao                                                           *
 * ------------------------------------------------------------------ */

/** Le um registrador do controlador RGB: byte alto da palavra. */
function readRegister(bus: SmbusBus, address: number, reg: number): number | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const word = bus.readWordData(address, reg);
      sleepSync(FURY_DELAY_MS);
      // 0xFFFF e barramento solto, nao resposta.
      if (word !== 0xffff) return (word >> 8) & 0xff;
    } catch {
      sleepSync(FURY_DELAY_MS);
    }
  }
  return null;
}

/**
 * Decide se vale sondar o controlador RGB deste slot.
 *
 * A porta principal e o SPD em 0x50+slot: se ele responde e diz "DDR4", ha
 * memoria naquele slot e o endereco 0x58+slot pertence a ela. A leitura do
 * SPD e SO LEITURA — nunca escrevemos naquele endereco, escrever ali
 * reprograma a memoria e a maquina para de bootar.
 *
 * O SPD e uma PISTA, nao um veredito. Em DDR4 ele e paginado: os enderecos
 * 0x36/0x37 (SPA0/SPA1) selecionam a pagina, e quem leu por ultimo decide qual
 * esta ativa. Se a pagina 1 estiver selecionada, o byte 0x02 nao e o tipo de
 * memoria e a leitura devolve qualquer coisa — foi exatamente o que aconteceu
 * nesta maquina, onde o SPD respondeu 0x00 com memoria DDR4 instalada.
 *
 * Nao trocamos a pagina de proposito: escrever em 0x36/0x37 afeta qualquer
 * outro software lendo SPD ao mesmo tempo, e o ganho nao compensa.
 *
 * Por isso, uma resposta inesperada do SPD nao elimina o slot — apenas deixa
 * de confirma-lo. Quem confirma de verdade e a assinatura "FURY" lida do
 * proprio controlador, logo depois. O SPD serve so para evitar sondar
 * enderecos de slots obviamente vazios.
 */
function slotHasCandidate(bus: SmbusBus, slot: number, log: (msg: string) => void): boolean {
  const spdAddress = SPD_BASE_ADDR + slot;

  try {
    if (bus.probe(spdAddress)) {
      const memoryType = bus.readByteData(spdAddress, SPD_REG_MEMORY_TYPE);
      if (memoryType === SPD_TYPE_DDR4) return true;

      log(
        `[fury] slot ${slot}: SPD respondeu tipo ${hex2(memoryType)} (pagina do SPD ` +
          'provavelmente nao e a 0); confiando na assinatura do controlador',
      );
    }
  } catch {
    // SPD ilegivel: tambem nao e motivo para desistir do slot.
  }

  return bus.probe(FURY_BASE_ADDR_DDR4 + slot);
}

/**
 * Teste de assinatura: os registradores 0x01..0x04 soletram "FURY" e 0x06
 * devolve um codigo de modelo conhecido.
 *
 * Precisa abrir e fechar transacao (0x08) porque o firmware so expoe esses
 * registradores com a transacao aberta. E a unica escrita que a deteccao faz,
 * e vai para 0x58+slot — nunca para o SPD.
 */
function testFurySignature(
  bus: SmbusBus,
  address: number,
  log: (msg: string) => void,
): number | null {
  const expected = 'FURY';

  // O SMBus e compartilhado e falha de vez em quando. Uma unica tentativa
  // frustrada aqui descartava o pente inteiro — observado na pratica: a
  // deteccao via dois modulos numa execucao e um na seguinte. As leituras
  // seguintes ja faziam retry; o unlock nao fazia.
  let unlocked = false;
  for (let attempt = 0; attempt < 3 && !unlocked; attempt++) {
    try {
      bus.writeByteData(address, REG.APPLY, TRANSFER.BEGIN);
      unlocked = true;
    } catch {
      sleepSync(FURY_DELAY_MS);
    }
  }
  if (!unlocked) {
    log(`[fury] ${hex2(address)}: nao respondeu ao unlock apos 3 tentativas`);
    return null;
  }
  sleepSync(FURY_DELAY_MS);

  let modelCode: number | null = null;

  try {
    for (let i = 0; i < expected.length; i++) {
      const value = readRegister(bus, address, i + 1);
      if (value === null || value !== expected.charCodeAt(i)) {
        log(`[fury] ${hex2(address)}: assinatura nao confere no registrador ${i + 1}`);
        return null;
      }
    }

    const model = readRegister(bus, address, REG.MODEL);
    if (model === null) {
      log(`[fury] ${hex2(address)}: codigo de modelo ilegivel`);
      return null;
    }
    if (model !== MODEL_BEAST_DDR4 && model !== MODEL_BEAST_WHITE_DDR4) {
      log(`[fury] ${hex2(address)}: modelo ${hex2(model)} nao suportado por este driver`);
      return null;
    }

    modelCode = model;
  } finally {
    try {
      bus.writeByteData(address, REG.APPLY, TRANSFER.END);
      sleepSync(FURY_DELAY_MS);
    } catch {
      // Transacao ja fechada ou pente sumiu; nada util a fazer aqui.
    }
  }

  return modelCode;
}

export const kingstonFuryDetector: ControllerDetector = {
  name: 'Kingston Fury DRAM SMBus',

  detect(ctx: DetectionContext): Controller[] {
    const found: Controller[] = [];

    for (const bus of ctx.smbus) {
      try {
        const slots: number[] = [];
        let modelCode = MODEL_BEAST_DDR4;

        for (let slot = 0; slot < MAX_SLOTS; slot++) {
          const rgbAddress = FURY_BASE_ADDR_DDR4 + slot;

          // Porta de seguranca: so encostamos no controlador RGB de um slot
          // que o SPD (ou, no pior caso, o proprio endereco) confirme ocupado.
          if (!slotHasCandidate(bus, slot, ctx.log)) continue;

          const model = testFurySignature(bus, rgbAddress, ctx.log);
          if (model === null) continue;

          ctx.log(
            `[fury] ${bus.name}: Fury confirmado em ${hex2(rgbAddress)} (modelo ${hex2(model)})`,
          );
          slots.push(slot);
          modelCode = model;
        }

        if (slots.length === 0) continue;

        // Modo atual, para nao sobrescrever o que o usuario deixou no boot.
        const firstAddress = FURY_BASE_ADDR_DDR4 + slots[0]!;
        const activeModeValue = readRegister(bus, firstAddress, REG.MODE) ?? MODE_VALUE.DIRECT;

        found.push(
          new KingstonFuryController({
            bus,
            slots,
            modelCode,
            activeModeValue,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`[fury] ${bus.name}: falha na deteccao: ${message}`);
      }
    }

    return found;
  },
};

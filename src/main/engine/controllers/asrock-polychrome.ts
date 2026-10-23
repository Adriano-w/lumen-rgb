/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 *
 * Driver portado do OpenRGB (GPL-2.0-or-later), release_1.1:
 *   Controllers/ASRockSMBusController/ASRockSMBusControllerDetect.cpp
 *   Controllers/ASRockSMBusController/ASRockPolychromeV2SMBusController/
 *     ASRockPolychromeV2SMBusController.{h,cpp}
 *     RGBController_ASRockPolychromeV2SMBus.cpp
 * Autor original: Adam Honse (CalcProgrammer1).
 */

/**
 * ASRock Polychrome v2 sobre SMBus.
 *
 * O controller mora sempre em 0x6A. O registrador 0x00 devolve um bloco de 2
 * bytes com a versao de firmware (major.minor); o major decide o protocolo:
 * 1 = ASR LED, 2 = Polychrome v1, 3 = Polychrome v2. Este arquivo implementa
 * apenas o v2 — e o que a B450M Steel Legend (firmware 3.4) fala.
 *
 * O protocolo e todo por bloco SMBus, nunca por byte:
 *
 *   0x00  leitura  bloco[2]  versao de firmware: [major, minor]
 *   0x30  escrita  bloco[1]  modo ativo (valores 0x10..0x1E)
 *   0x30  leitura  bloco[1]  modo ativo atual
 *   0x31  escrita  bloco[1]  seleciona o LED que a proxima cor vai pintar
 *   0x32  r/w      bloco[1]  quantos LEDs tem a fita ARGB ligada no header,
 *                            e tambem o registrador que arma o enderecamento
 *                            por LED. Medido: escrever 7 e ler devolve 7;
 *                            escrever 80 devolve 80. O upstream escreve um
 *                            bloco VAZIO aqui, que no fio e o byte 0 — isso
 *                            zera a contagem, e e por isso que o OpenRGB
 *                            enxerga o header como um LED so.
 *   0x33  leitura  bloco[6]  contagem de LEDs das 6 zonas
 *   0x34  escrita  bloco[3]  cor do LED selecionado: [R, G, B]
 *   0x35  r/w      bloco[1]  inverte R/G do header enderecavel (o "MBSwap"
 *                            da utilidade da ASRock). Nao mexemos nele.
 *   <modo> escrita bloco[1]  velocidade do modo, no registrador do PROPRIO
 *                            modo (0x12 para Breathing, 0x17 para Wave, ...)
 *
 * Duas pegadinhas que vieram do firmware e nao da nossa cabeca:
 *
 *  1. **Nao existe modo "Direct".** O que aceita cor por LED e o "Static":
 *     escrever em 0x31/0x34 com Static ativo acende o LED na hora. Por isso
 *     `directModeIndex` aponta para Static.
 *
 *  2. **O firmware grava sozinho na flash a cada escrita.** Nao ha comando de
 *     save — e por isso tambem nao ha `save()` aqui: seria um no-op mentiroso.
 *     A contrapartida e que efeitos em alta taxa desgastam a flash; quem chama
 *     deve limitar o FPS. Nos ajudamos nao reescrevendo LED que nao mudou.
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

/** Unico endereco que a familia usa. Nao varremos nada alem disso. */
const POLYCHROME_ADDRESS = 0x6a;

const REG = {
  FIRMWARE_VER: 0x00,
  MODE: 0x30,
  LED_SELECT: 0x31,
  LED_COUNT: 0x32,
  LED_CONFIG: 0x33,
  COLOR: 0x34,
  ARGB_GRB: 0x35,
} as const;

/** Major da versao de firmware -> familia de protocolo. */
const FIRMWARE_FAMILY = {
  ASR_LED: 0x01,
  POLYCHROME_V1: 0x02,
  POLYCHROME_V2: 0x03,
} as const;

const MODE_VALUE = {
  OFF: 0x10,
  STATIC: 0x11,
  BREATHING: 0x12,
  STROBE: 0x13,
  SPECTRUM_CYCLE: 0x14,
  RANDOM: 0x15,
  WAVE: 0x17,
  SPRING: 0x18,
  STACK: 0x19,
  CRAM: 0x1a,
  SCAN: 0x1b,
  NEON: 0x1c,
  WATER: 0x1d,
  RAINBOW: 0x1e,
} as const;

/** Numero de zonas que o registrador 0x33 descreve. */
const ZONE_COUNT = 6;

/** Indice da zona do header enderecavel dentro das 6. */
const ZONE_ADDRESSABLE = 5;

/**
 * Primeiro byte de selecao do header enderecavel.
 *
 * Os LEDs da placa usam o indice corrido (0..22); a fita ARGB tem espaco
 * proprio, comecando em 0x19. O LED n da fita e `0x19 + n`.
 *
 * O upstream trata esse byte como FIXO, o que pinta a fita inteira de uma cor
 * — mas so porque ele tambem zera a contagem em 0x32. Com a contagem correta
 * escrita, o firmware aceita enderecar cada LED.
 */
const ADDRESSABLE_SELECT_BYTE = 0x19;

const ZONE_NAMES = [
  'RGB LED 1 Header',
  'RGB LED 2 Header',
  'Audio',
  'PCH',
  'IO Cover',
  'Addressable Header',
] as const;

/**
 * O firmware precisa de um respiro entre transacoes; o OpenRGB usa 1 ms e e
 * o que replicamos. Menos que isso provoca escritas perdidas.
 */
const WRITE_DELAY_MS = 1;

/**
 * Tabela de modos, na ordem em que a UI vai mostrar.
 *
 * Em velocidade, `min` e o valor mais LENTO e `max` o mais RAPIDO — e no fio
 * o mais rapido e o numero MENOR. Por isso varios modos tem `min > max`.
 * Mantemos os numeros crus do OpenRGB para nao introduzir uma traducao que o
 * firmware nao conhece.
 */
interface PolychromeModeSpec extends ControllerMode {
  /** Aceita cor por LED via 0x31/0x34. */
  perLed: boolean;
}

const MODES: readonly PolychromeModeSpec[] = [
  { name: 'Off', value: MODE_VALUE.OFF, perLed: false, colorsMin: 0, colorsMax: 0 },
  { name: 'Static', value: MODE_VALUE.STATIC, perLed: true, colorsMin: 0, colorsMax: 0 },
  {
    name: 'Breathing',
    value: MODE_VALUE.BREATHING,
    perLed: true,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x0a, max: 0x02, default: 0x06 },
  },
  {
    name: 'Strobe',
    value: MODE_VALUE.STROBE,
    perLed: true,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0xa0, max: 0x05, default: 0x4d },
  },
  {
    name: 'Spectrum Cycle',
    value: MODE_VALUE.SPECTRUM_CYCLE,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0xa0, max: 0x0a, default: 0x50 },
  },
  {
    name: 'Random',
    value: MODE_VALUE.RANDOM,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0xa0, max: 0x05, default: 0x4d },
  },
  {
    name: 'Wave',
    value: MODE_VALUE.WAVE,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x06, max: 0x01, default: 0x03 },
  },
  {
    name: 'Spring',
    value: MODE_VALUE.SPRING,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x20, max: 0x02, default: 0x11 },
  },
  {
    name: 'Stack',
    value: MODE_VALUE.STACK,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x20, max: 0x02, default: 0x11 },
  },
  {
    name: 'Cram',
    value: MODE_VALUE.CRAM,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x20, max: 0x02, default: 0x11 },
  },
  {
    name: 'Scan',
    value: MODE_VALUE.SCAN,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x20, max: 0x02, default: 0x11 },
  },
  {
    name: 'Neon',
    value: MODE_VALUE.NEON,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x20, max: 0x02, default: 0x11 },
  },
  {
    name: 'Water',
    value: MODE_VALUE.WATER,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x20, max: 0x02, default: 0x11 },
  },
  {
    name: 'Rainbow',
    value: MODE_VALUE.RAINBOW,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: 0x12, max: 0x02, default: 0x08 },
  },
];

/** Static e quem aceita cor por LED; o Lumen usa ele como "direct". */
const DIRECT_MODE_INDEX = MODES.findIndex((m) => m.value === MODE_VALUE.STATIC);

/**
 * Modos em que o firmware ignora as cores enviadas — escrever nelas e so
 * gastar barramento (e flash).
 */
const MODES_WITHOUT_COLOR: readonly number[] = [
  MODE_VALUE.OFF,
  MODE_VALUE.RAINBOW,
  MODE_VALUE.SPECTRUM_CYCLE,
];

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

/** Pedaco estavel de identidade: o nome do barramento sem espaco nem caixa. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function hex2(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * Controller                                                         *
 * ------------------------------------------------------------------ */

/** Tudo que a deteccao descobriu e o controller precisa para existir. */
interface PolychromeInfo {
  bus: SmbusBus;
  address: number;
  firmwareMajor: number;
  firmwareMinor: number;
  /** Contagem crua das 6 zonas, como veio de 0x33 (capacidade, nao uso). */
  zoneLedCounts: readonly number[];
  /** LEDs realmente ligados no header ARGB, conforme 0x32. */
  addressableLedCount: number;
  /** Modo lido do device na deteccao, em valor de fio. */
  activeModeValue: number;
}

class PolychromeV2Controller implements Controller {
  readonly id: string;
  readonly name = 'ASRock Polychrome v2';
  readonly vendor = 'ASRock';
  readonly type = 'motherboard' as const;
  readonly location: string;
  /** Placa-mae por SMBus: barramento lento e compartilhado com o SPD. */
  readonly transport = 'smbus' as const;
  readonly version: string;
  readonly serial = '';

  // O layout nao e imutavel porque o header ARGB e redimensionavel: quantos
  // LEDs existem na fita e algo que o usuario configura (ver `resizeZone`).
  zones: readonly ControllerZone[] = [];
  readonly modes: readonly ControllerMode[] = MODES;
  ledCount = 0;
  ledNames: readonly string[] = [];
  readonly directModeIndex = DIRECT_MODE_INDEX;

  /**
   * O firmware v2 autosalva na flash a cada escrita de cor — nao existe
   * registrador de save porque ele nunca precisa de um. Logo, todo frame de
   * um efeito em software consome um ciclo de escrita de um orcamento finito.
   * O motor usa esta flag para reduzir a taxa e avisar o usuario.
   */
  readonly writeWearRisk = true;

  private readonly bus: SmbusBus;
  private readonly address: number;

  /** Byte que vai para 0x31 ao pintar cada LED, por indice global. */
  private ledSelectBytes: readonly number[] = [];
  /** Primeiro indice global de LED de cada zona presente. */
  private zoneOffsets: readonly number[] = [];
  /** Contagem crua das 6 zonas, como veio de 0x33. */
  private readonly zoneLedCounts: readonly number[];
  /** Indice, em `zones`, da zona do header enderecavel (-1 se ausente). */
  private addressableZoneIndex = -1;
  /** Quantos LEDs a fita ARGB tem, conforme o registrador 0x32. */
  private addressableLedCount: number;

  private activeMode: number;
  private activeSpeed: number;

  /**
   * Ultima cor escrita por LED, empacotada em 0xRRGGBB, ou -1 quando nao
   * sabemos. Serve para nao repetir escrita que nao muda nada: o SMBus e
   * lento e compartilhado, e cada escrita aqui e uma gravacao em flash.
   */
  private lastWritten: number[] = [];

  constructor(info: PolychromeInfo) {
    this.bus = info.bus;
    this.address = info.address;
    this.zoneLedCounts = info.zoneLedCounts;

    this.id = `asrock-polychrome:${slug(info.bus.name)}:${hex2(info.address).toLowerCase()}`;
    this.location = `${info.bus.name}, address ${hex2(info.address)}`;
    this.version = `${info.firmwareMajor}.${info.firmwareMinor}`;

    this.addressableLedCount = info.addressableLedCount;
    this.buildLayout();

    const modeIdx = MODES.findIndex((m) => m.value === info.activeModeValue);
    this.activeMode = modeIdx >= 0 ? modeIdx : DIRECT_MODE_INDEX;
    this.activeSpeed = MODES[this.activeMode]?.speed?.default ?? 0;
  }

  /**
   * Monta zonas, nomes e bytes de selecao a partir da contagem das zonas.
   *
   * Reexecutavel porque o header ARGB e redimensionavel: trocar o numero de
   * LEDs da fita muda o total do device e os indices de tudo que vem depois.
   */
  private buildLayout(): void {
    const zones: ControllerZone[] = [];
    const zoneOffsets: number[] = [];
    const ledNames: string[] = [];
    const ledSelectBytes: number[] = [];

    for (let zoneIdx = 0; zoneIdx < ZONE_COUNT; zoneIdx++) {
      const reported = this.zoneLedCounts[zoneIdx] ?? 0;
      if (reported <= 0) continue;

      const isAddressable = zoneIdx === ZONE_ADDRESSABLE;

      // O firmware reporta em 0x33 a CAPACIDADE do header (80 nesta placa),
      // nao quantos LEDs existem de fato na fita. Quantos existem e o que
      // estiver no registrador 0x32 — e isso o usuario configura.
      const ledCount = isAddressable ? this.addressableLedCount : reported;
      const zoneName = ZONE_NAMES[zoneIdx] ?? `Zone ${zoneIdx + 1}`;

      if (isAddressable) this.addressableZoneIndex = zones.length;

      zoneOffsets.push(ledNames.length);
      zones.push({
        name: zoneName,
        type: ledCount > 1 ? 'linear' : 'single',
        ledCount,
        ledsMin: isAddressable ? 1 : ledCount,
        ledsMax: isAddressable ? reported : ledCount,
      });

      for (let ledIdx = 0; ledIdx < ledCount; ledIdx++) {
        // Nas zonas da placa o byte de selecao e o indice corrido do LED. O
        // header enderecavel tem espaco proprio, comecando em 0x19.
        ledSelectBytes.push(
          isAddressable ? ADDRESSABLE_SELECT_BYTE + ledIdx : ledNames.length,
        );
        ledNames.push(`${zoneName} ${ledIdx + 1}`);
      }
    }

    this.zones = zones;
    this.zoneOffsets = zoneOffsets;
    this.ledNames = ledNames;
    this.ledSelectBytes = ledSelectBytes;
    this.ledCount = ledNames.length;
    this.lastWritten = new Array<number>(this.ledCount).fill(-1);
  }

  /**
   * Redimensiona o header ARGB.
   *
   * A contagem mora no proprio hardware (registrador 0x32) e sobrevive a
   * reinicios — e, como todo o resto neste firmware, autosalva. Por isso so
   * escrevemos quando o valor realmente muda.
   */
  resizeZone(zoneIndex: number, ledCount: number): void {
    if (zoneIndex !== this.addressableZoneIndex) {
      throw new Error('apenas o header enderecavel pode ser redimensionado');
    }

    const max = this.zoneLedCounts[ZONE_ADDRESSABLE] ?? 1;
    const next = Math.max(1, Math.min(max, Math.round(ledCount)));
    if (next === this.addressableLedCount) return;

    this.writeBlock(REG.LED_COUNT, [next]);
    this.addressableLedCount = next;
    this.buildLayout();
  }

  getActiveMode(): number {
    return this.activeMode;
  }

  setMode(modeIndex: number, options: SetModeOptions): void {
    const mode = MODES[modeIndex];
    if (!mode) {
      throw new Error(`modo ${modeIndex} nao existe no Polychrome v2`);
    }

    const speed =
      mode.speed === undefined
        ? 0
        : clampToRange(options.speed ?? mode.speed.default, mode.speed.min, mode.speed.max);

    // 1. Seleciona o modo.
    this.writeBlock(REG.MODE, [mode.value]);

    // 2. Reafirma 0x32 — o registrador que arma o enderecamento por LED.
    //
    //    O upstream escreve um bloco VAZIO aqui. Isso vira, no fio, o byte 0,
    //    e 0x32 e tambem onde mora a CONTAGEM de LEDs da fita ARGB: escrever
    //    zero descartaria a configuracao do usuario (o firmware a trata como
    //    1). Escrevemos a contagem atual, que arma o enderecamento do mesmo
    //    jeito sem destruir nada.
    this.writeBlock(REG.LED_COUNT, [this.addressableLedCount]);

    // 3. A velocidade vai no registrador do proprio modo. Off e Static nao
    //    tem velocidade e rejeitam essa escrita.
    if (mode.value !== MODE_VALUE.OFF && mode.value !== MODE_VALUE.STATIC) {
      this.writeBlock(mode.value, [toByte(speed)]);
    }

    this.activeMode = modeIndex;
    this.activeSpeed = speed;

    // A troca de modo mexe no estado interno do firmware; o cache de cores
    // deixa de valer.
    this.lastWritten.fill(-1);

    if (options.colors && options.colors.length > 0) {
      this.updateLeds(expandColors(options.colors, this.ledCount));
    }
  }

  updateLeds(colors: readonly RGB[]): void {
    if (this.skipColorWrites()) return;
    const count = Math.min(colors.length, this.ledCount);
    for (let i = 0; i < count; i++) {
      this.writeLed(i, colors[i]!);
    }
  }

  updateZoneLeds(zoneIndex: number, colors: readonly RGB[]): void {
    const zone = this.zones[zoneIndex];
    const offset = this.zoneOffsets[zoneIndex];
    if (!zone || offset === undefined) {
      throw new Error(`zona ${zoneIndex} nao existe no Polychrome v2`);
    }
    if (this.skipColorWrites()) return;

    const count = Math.min(colors.length, zone.ledCount);
    for (let i = 0; i < count; i++) {
      this.writeLed(offset + i, colors[i]!);
    }
  }

  close(): void {
    // Nada a liberar: o barramento SMBus e do HAL, nao nosso.
  }

  /* ---------------------------------------------------------------- *
   * Interno                                                          *
   * ---------------------------------------------------------------- */

  /** Velocidade atualmente programada, exposta para diagnostico. */
  getActiveSpeed(): number {
    return this.activeSpeed;
  }

  private skipColorWrites(): boolean {
    const value = MODES[this.activeMode]?.value ?? MODE_VALUE.OFF;
    return MODES_WITHOUT_COLOR.includes(value);
  }

  private writeLed(index: number, color: RGB): void {
    const select = this.ledSelectBytes[index];
    if (select === undefined) return;

    const r = toByte(color.r);
    const g = toByte(color.g);
    const b = toByte(color.b);
    const packed = (r << 16) | (g << 8) | b;

    // Escrita redundante aqui custa duas transacoes SMBus E um ciclo de
    // gravacao em flash. Vale muito a pena pular.
    if (this.lastWritten[index] === packed) return;

    this.writeBlock(REG.LED_SELECT, [select]);
    this.writeBlock(REG.COLOR, [r, g, b]);
    this.lastWritten[index] = packed;
  }

  private writeBlock(command: number, data: readonly number[]): void {
    this.bus.writeBlockData(this.address, command, Uint8Array.from(data));
    sleepSync(WRITE_DELAY_MS);
  }
}

/** Repete a paleta ate cobrir todos os LEDs. */
function expandColors(colors: readonly RGB[], count: number): RGB[] {
  const out: RGB[] = new Array<RGB>(count);
  for (let i = 0; i < count; i++) {
    out[i] = colors[i % colors.length]!;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Deteccao                                                           *
 * ------------------------------------------------------------------ */

/**
 * Le a versao de firmware. O bloco tem exatamente 2 bytes; qualquer outro
 * tamanho significa "tem alguem em 0x6A, mas nao e um Polychrome".
 */
function readFirmwareVersion(bus: SmbusBus): { major: number; minor: number } | null {
  const block = bus.readBlockData(POLYCHROME_ADDRESS, REG.FIRMWARE_VER);
  if (block.length !== 2) return null;
  return { major: block[0]!, minor: block[1]! };
}

/** Le a contagem de LEDs das 6 zonas. Tamanho diferente de 6 = nao e v2. */
function readZoneConfiguration(bus: SmbusBus): number[] | null {
  const block = bus.readBlockData(POLYCHROME_ADDRESS, REG.LED_CONFIG);
  if (block.length !== ZONE_COUNT) return null;
  return Array.from(block);
}

/**
 * Le quantos LEDs a fita ARGB tem, do registrador 0x32.
 *
 * A zona em 0x33 reporta a CAPACIDADE do header (80 nesta placa); 0x32 guarda
 * quantos LEDs estao realmente ligados nele. O valor vive no hardware e
 * sobrevive a reinicios, entao ele — e nao um padrao nosso — e a verdade.
 *
 * Falha aqui nao e fatal: 1 LED e o comportamento conservador, que pinta a
 * fita inteira de uma cor.
 */
function readAddressableLedCount(bus: SmbusBus, max: number): number {
  try {
    const block = bus.readBlockData(POLYCHROME_ADDRESS, REG.LED_COUNT);
    const value = block[0] ?? 1;
    return Math.max(1, Math.min(max, value));
  } catch {
    return 1;
  }
}

/** Le o modo ativo. Falha aqui nao e fatal — assumimos Static. */
function readActiveMode(bus: SmbusBus): number | null {
  try {
    const block = bus.readBlockData(POLYCHROME_ADDRESS, REG.MODE);
    if (block.length !== 1) return null;
    return block[0]!;
  } catch {
    return null;
  }
}

export const asrockPolychromeDetector: ControllerDetector = {
  name: 'ASRock Polychrome SMBus',

  detect(ctx: DetectionContext): Controller[] {
    const found: Controller[] = [];

    for (const bus of ctx.smbus) {
      try {
        // Varredura so de leitura, e so no unico endereco da familia.
        if (!bus.probe(POLYCHROME_ADDRESS)) continue;

        ctx.log(
          `[polychrome] alguem respondeu em ${hex2(POLYCHROME_ADDRESS)} no ${bus.name}, ` +
            'conferindo assinatura',
        );

        // Assinatura: 0x00 tem que devolver um bloco de 2 bytes com um major
        // conhecido. Um ACK sozinho nao prova nada — 0x6A pode ser qualquer
        // coisa em placa de outro fabricante.
        const version = readFirmwareVersion(bus);
        if (!version) {
          ctx.log(`[polychrome] ${bus.name}: 0x6A respondeu mas nao devolveu versao; ignorando`);
          continue;
        }

        if (version.major !== FIRMWARE_FAMILY.POLYCHROME_V2) {
          const family =
            version.major === FIRMWARE_FAMILY.ASR_LED
              ? 'ASR LED (firmware 1.x)'
              : version.major === FIRMWARE_FAMILY.POLYCHROME_V1
                ? 'Polychrome v1 (firmware 2.x)'
                : `desconhecida (major ${version.major})`;
          ctx.log(
            `[polychrome] ${bus.name}: familia ${family} nao suportada por este driver; ignorando`,
          );
          continue;
        }

        const zoneLedCounts = readZoneConfiguration(bus);
        if (!zoneLedCounts) {
          ctx.log(`[polychrome] ${bus.name}: configuracao de zonas invalida; ignorando`);
          continue;
        }

        const total = zoneLedCounts.reduce((sum, n) => sum + n, 0);
        if (total === 0) {
          ctx.log(`[polychrome] ${bus.name}: firmware reportou zero LEDs; ignorando`);
          continue;
        }

        const activeModeValue = readActiveMode(bus) ?? MODE_VALUE.STATIC;

        ctx.log(
          `[polychrome] ${bus.name}: Polychrome v2 v${version.major}.${version.minor}, ` +
            `zonas [${zoneLedCounts.join(', ')}], modo atual ${hex2(activeModeValue)}`,
        );

        found.push(
          new PolychromeV2Controller({
            bus,
            address: POLYCHROME_ADDRESS,
            firmwareMajor: version.major,
            firmwareMinor: version.minor,
            zoneLedCounts,
            addressableLedCount: readAddressableLedCount(
              bus,
              zoneLedCounts[ZONE_ADDRESSABLE] ?? 1,
            ),
            activeModeValue,
          }),
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log(`[polychrome] ${bus.name}: falha ao sondar 0x6A: ${message}`);
      }
    }

    return found;
  },
};

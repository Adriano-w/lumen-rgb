/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 *
 * Portado do OpenRGB (GPL-2.0-or-later):
 *   - Controllers/GigabyteRGBFusionGPUController/GigabyteRGBFusionGPUController.cpp
 *     e .h (registradores 0x40/0x88/0xAA, valores de modo, faixas de
 *     velocidade e brilho)
 *   - Controllers/GigabyteRGBFusionGPUController/
 *     GigabyteRGBFusionGPUControllerDetect.cpp (aperto de mao 0xAB e a tabela
 *     que casa device + subsystem id com o endereco I2C)
 *   - Controllers/GigabyteRGBFusionGPUController/
 *     RGBController_GigabyteRGBFusionGPU.cpp (zona unica, lista de modos)
 *   - pci_ids/pci_ids.h (os ids propriamente ditos)
 */

/**
 * Controller RGB Fusion embarcado em placas de video Gigabyte.
 *
 * O chip RGB mora num barramento I2C da propria GPU, nao no SMBus da
 * placa-mae. Chegamos nele pelo NVAPI (veja `hal/nvapi.ts`).
 *
 * **Por que o subsystem id e obrigatorio.** O id de device PCI identifica o
 * chip da NVIDIA, que e o mesmo em placas de todos os fabricantes. Quem diz que
 * ali existe um RGB Fusion — e em qual endereco — e o subsystem id, que
 * identifica o modelo da placa. Sair escrevendo num endereco I2C de GPU so
 * porque o chip e NVIDIA e uma otima forma de conversar com o chip de
 * monitoramento errado.
 */
import type { RGB } from '../../../shared/types.js';
import type {
  Controller,
  ControllerDetector,
  ControllerMode,
  ControllerZone,
  DetectionContext,
  I2cBus,
  SetModeOptions,
} from '../hal/types.js';
import { hasPciIdentity, type PciI2cBus } from '../hal/nvapi.js';

/* ------------------------------------------------------------------ *
 * Protocolo                                                          *
 * ------------------------------------------------------------------ */

/** Registradores. Cada um abre uma sequencia de 4 bytes. */
const REG_COLOR = 0x40;
const REG_MODE = 0x88;
const REG_SAVE = 0xaa;

/** Byte que abre o aperto de mao de identificacao. */
const PROBE_MAGIC = 0xab;

/** Versoes de firmware que o aperto de mao pode devolver. */
const KNOWN_FIRMWARE = [0x10, 0x11, 0x12, 0x14];

const MODE_STATIC = 0x01;
const MODE_BREATHING = 0x02;
const MODE_FLASHING = 0x04;
const MODE_DUAL_FLASHING = 0x08;
const MODE_COLOR_CYCLE = 0x10;
// 0x11 nao e um modo: e `MODE_COLOR_CYCLE | MODE_STATIC`, e o firmware
// responde piscando. Mantido documentado para ninguem reintroduzir.
// const MODE_SPECTRUM_CYCLE = 0x11;

/** Velocidade: 0 mais lento, 9 mais rapido. */
const SPEED_SLOWEST = 0x00;
const SPEED_NORMAL = 0x05;
const SPEED_FASTEST = 0x09;

const BRIGHTNESS_MIN = 0x00;
const BRIGHTNESS_MAX = 0x63;

/**
 * Enderecos que precisam de enchimento.
 *
 * Alguns controllers da familia so aceitam comandos de 8 bytes. O OpenRGB
 * descobriu isso no 0x62 e completa com zeros; replicamos a condicao pelo
 * endereco, como la.
 */
const PADDED_ADDRESSES = new Set([0x62]);

const NVIDIA_VENDOR = 0x10de;
const GIGABYTE_SUBVENDOR = 0x1458;

/* ------------------------------------------------------------------ *
 * Catalogo                                                           *
 * ------------------------------------------------------------------ */

interface GpuSpec {
  /** Ids de device PCI que compartilham esta placa (variantes do mesmo chip). */
  deviceIds: readonly number[];
  subsystemDeviceId: number;
  address: number;
  name: string;
}

/**
 * Placas conhecidas.
 *
 * Um modelo pode aparecer varias vezes porque a Gigabyte revisou a placa
 * trocando o silicio (GA106, GA104, LHR) sem mexer no subsystem id nem no
 * controller RGB. A tabela e so de modelos verificados no OpenRGB.
 */
const SUPPORTED_GPUS: readonly GpuSpec[] = [
  {
    // O alvo: Gigabyte GeForce RTX 3060 EAGLE OC 12G.
    deviceIds: [0x2503, 0x2487, 0x2504],
    subsystemDeviceId: 0x4072,
    address: 0x63,
    name: 'Gigabyte GeForce RTX 3060 EAGLE OC',
  },
  {
    deviceIds: [0x2504],
    subsystemDeviceId: 0x4071,
    address: 0x63,
    name: 'Gigabyte GeForce RTX 3060 EAGLE LHR V2',
  },
  {
    deviceIds: [0x2503, 0x2504, 0x2487],
    subsystemDeviceId: 0x4073,
    address: 0x63,
    name: 'Gigabyte GeForce RTX 3060 Vision OC',
  },
  {
    deviceIds: [0x2503, 0x2487, 0x2504],
    subsystemDeviceId: 0x4074,
    address: 0x62,
    name: 'Gigabyte GeForce RTX 3060 Gaming OC',
  },
  {
    deviceIds: [0x2486, 0x2489],
    subsystemDeviceId: 0x405b,
    address: 0x63,
    name: 'Gigabyte GeForce RTX 3060 Ti EAGLE OC',
  },
  {
    deviceIds: [0x2489],
    subsystemDeviceId: 0x4060,
    address: 0x63,
    name: 'Gigabyte GeForce RTX 3060 Ti EAGLE OC LHR V2',
  },
  {
    deviceIds: [0x2489],
    subsystemDeviceId: 0x4077,
    address: 0x63,
    name: 'Gigabyte GeForce RTX 3060 Ti Vision OC',
  },
];

/* ------------------------------------------------------------------ *
 * Controller                                                         *
 * ------------------------------------------------------------------ */

interface FusionMode extends ControllerMode {
  /** True quando o modo gera as proprias cores e ignora o registrador 0x40. */
  readonly generatesOwnColors: boolean;
}

const MODES: readonly FusionMode[] = [
  {
    name: 'Direct',
    value: MODE_STATIC,
    perLed: true,
    colorsMin: 1,
    colorsMax: 1,
    brightness: { min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX, default: BRIGHTNESS_MAX },
    generatesOwnColors: false,
  },
  {
    name: 'Breathing',
    value: MODE_BREATHING,
    perLed: true,
    colorsMin: 1,
    colorsMax: 1,
    speed: { min: SPEED_SLOWEST, max: SPEED_FASTEST, default: SPEED_NORMAL },
    brightness: { min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX, default: BRIGHTNESS_MAX },
    generatesOwnColors: false,
  },
  {
    name: 'Flashing',
    value: MODE_FLASHING,
    perLed: true,
    colorsMin: 1,
    colorsMax: 1,
    speed: { min: SPEED_SLOWEST, max: SPEED_FASTEST, default: SPEED_NORMAL },
    brightness: { min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX, default: BRIGHTNESS_MAX },
    generatesOwnColors: false,
  },
  {
    name: 'Dual Flashing',
    value: MODE_DUAL_FLASHING,
    perLed: true,
    colorsMin: 1,
    colorsMax: 1,
    speed: { min: SPEED_SLOWEST, max: SPEED_FASTEST, default: SPEED_NORMAL },
    brightness: { min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX, default: BRIGHTNESS_MAX },
    generatesOwnColors: false,
  },
  {
    name: 'Color Cycle',
    value: MODE_COLOR_CYCLE,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    speed: { min: SPEED_SLOWEST, max: SPEED_FASTEST, default: SPEED_NORMAL },
    brightness: { min: BRIGHTNESS_MIN, max: BRIGHTNESS_MAX, default: BRIGHTNESS_MAX },
    generatesOwnColors: true,
  },
  // "Spectrum Cycle" (0x11) foi REMOVIDO.
  //
  // Os valores de modo desta familia sao bits: 0x01 estatico, 0x02 respiracao,
  // 0x04 piscando, 0x08 piscando duplo, 0x10 ciclo de cores. O 0x11 e
  // `0x10 | 0x01` — uma combinacao que o firmware nao trata como modo valido.
  //
  // Verificado nesta maquina varrendo os valores um a um: 0x10 cicla cores de
  // forma continua, 0x11 faz a placa PISCAR. Expor 0x11 como "Spectrum Cycle"
  // dava ao usuario um modo que parecia quebrado — e era o padrao que o
  // restore escolhia, porque o nome batia com o das outras placas.
];

/**
 * A placa tem um unico LED enderecavel, com um unico modo de firmware ativo.
 *
 * Cada escrita custa quatro (ou oito) transacoes I2C atravessando o driver de
 * video. Nao da para tratar isso como um framebuffer: `updateLeds` pula a
 * escrita quando a cor nao mudou, que e o que torna o modo Direct utilizavel
 * por um motor de efeitos sem derrubar o desempenho do sistema.
 */
class GigabyteFusionGpuController implements Controller {
  readonly id: string;
  readonly name: string;
  readonly vendor = 'Gigabyte';
  readonly type = 'gpu' as const;
  readonly location: string;
  /** I2C da GPU via NVAPI: lento, parecido com SMBus. */
  readonly transport = 'gpu-i2c' as const;
  readonly version: string;
  readonly serial = '';

  readonly zones: readonly ControllerZone[] = [
    { name: 'GPU Zone', type: 'single', ledCount: 1, ledsMin: 1, ledsMax: 1 },
  ];
  readonly modes: readonly FusionMode[] = MODES;
  readonly ledCount = 1;
  readonly ledNames: readonly string[] = ['GPU LED'];
  readonly directModeIndex = 0;

  private activeMode = 0;
  private speed = SPEED_NORMAL;
  private brightness = BRIGHTNESS_MAX;
  private lastColor: number | null = null;
  private readonly padding: number;
  private closed = false;

  constructor(
    private readonly bus: I2cBus,
    private readonly address: number,
    name: string,
    firmware: number,
    gpuIndex: number,
  ) {
    this.name = name;
    this.version = `firmware 0x${firmware.toString(16).padStart(2, '0')}`;
    this.location = `I2C: ${bus.name}, endereco 0x${address.toString(16)}`;
    this.id = `gigabyte-gpu:${gpuIndex}:0x${address.toString(16)}`;
    this.padding = PADDED_ADDRESSES.has(address) ? 4 : 0;
  }

  getActiveMode(): number {
    return this.activeMode;
  }

  setMode(modeIndex: number, options: SetModeOptions): void {
    if (this.closed) return;
    const mode = this.modes[modeIndex];
    if (!mode) return;

    this.activeMode = modeIndex;

    if (typeof options.speed === 'number') {
      this.speed = clamp(Math.round(options.speed), SPEED_SLOWEST, SPEED_FASTEST);
    }
    if (typeof options.brightness === 'number') {
      this.brightness = clamp(Math.round(options.brightness), BRIGHTNESS_MIN, BRIGHTNESS_MAX);
    }

    const color = options.colors?.[0];
    if (color && !mode.generatesOwnColors) {
      // A cor antes do modo: assim a placa ja entra no modo novo pintada.
      this.writeColor(color, true);
    } else {
      this.lastColor = null;
    }

    this.command(REG_MODE, [mode.value, this.speed, this.brightness]);
  }

  updateLeds(colors: readonly RGB[]): void {
    if (this.closed) return;
    const color = colors[0];
    if (!color) return;
    this.writeColor(color, false);
  }

  updateZoneLeds(zoneIndex: number, colors: readonly RGB[]): void {
    if (zoneIndex !== 0) return;
    this.updateLeds(colors);
  }

  /** Grava na flash do controller. Desgasta a memoria: so a pedido explicito. */
  save(): void {
    if (this.closed) return;
    const mode = this.modes[this.activeMode];
    if (!mode) return;

    this.command(REG_MODE, [mode.value, this.speed, this.brightness]);
    this.command(REG_SAVE, [0x00, 0x00, 0x00]);
  }

  close(): void {
    // Nao ha handle: o barramento NVAPI pertence a camada HAL e e fechado la.
    this.closed = true;
  }

  /* ---------------------------------------------------------------- *
   * Fio                                                              *
   * ---------------------------------------------------------------- */

  private writeColor(color: RGB, force: boolean): void {
    const mode = this.modes[this.activeMode];
    // Escrever o registrador de cor durante um ciclo de cores gerado pelo
    // firmware interrompe o ciclo. Nos modos sem cor, nao mexa.
    if (mode?.generatesOwnColors) return;

    const packed = (color.r << 16) | (color.g << 8) | color.b;
    if (!force && this.lastColor === packed) return;
    this.lastColor = packed;

    this.command(REG_COLOR, [color.r & 0xff, color.g & 0xff, color.b & 0xff]);
  }

  /**
   * Um comando: o registrador e tres bytes de argumento.
   *
   * O `I2cBus` envia o registrador e cada byte como transacoes separadas de um
   * byte, que e o enquadramento que este firmware espera.
   */
  private command(register: number, args: readonly number[]): void {
    const payload = new Uint8Array(args.length + this.padding);
    payload.set(args, 0);
    // O restante ja esta zerado — e exatamente o enchimento esperado.

    try {
      this.bus.write(this.address, register, payload);
    } catch {
      // Um comando perdido nao justifica repetir: este barramento e lento e um
      // laco de retry trava a thread principal. O proximo quadro corrige.
      // Invalidamos o cache para que a proxima cor seja reenviada de fato.
      this.lastColor = null;
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/* ------------------------------------------------------------------ *
 * Deteccao                                                           *
 * ------------------------------------------------------------------ */

/**
 * Aperto de mao do RGB Fusion.
 *
 * Escreve `0xAB` seguido de zeros e espera ler de volta `0xAB` e uma versao de
 * firmware conhecida. Isso **escreve** no barramento, por isso so roda depois
 * que o subsystem id confirmou qual placa e e qual endereco usar — nunca como
 * varredura.
 */
function probeFusionController(
  bus: I2cBus,
  address: number,
  log: (msg: string) => void,
): number | null {
  const padding = PADDED_ADDRESSES.has(address) ? 4 : 0;

  try {
    bus.write(address, PROBE_MAGIC, new Uint8Array(3 + padding));

    const response = bus.read(address, -1, 4);

    if (response[0] !== PROBE_MAGIC) {
      log(
        `RGB Fusion GPU em 0x${address.toString(16)}: esperava 0xAB, ` +
          `recebi 0x${(response[0] ?? 0).toString(16)}`,
      );
      return null;
    }

    const firmware = response[1] ?? 0;
    if (!KNOWN_FIRMWARE.includes(firmware)) {
      log(
        `RGB Fusion GPU em 0x${address.toString(16)}: firmware ` +
          `0x${firmware.toString(16)} fora da lista conhecida`,
      );
      return null;
    }

    return firmware;
  } catch (err) {
    log(
      `RGB Fusion GPU em 0x${address.toString(16)}: aperto de mao falhou ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}

function matchGpu(bus: PciI2cBus): GpuSpec | null {
  if (bus.pciVendorId !== NVIDIA_VENDOR) return null;
  if (bus.pciSubsystemVendorId !== GIGABYTE_SUBVENDOR) return null;

  return (
    SUPPORTED_GPUS.find(
      (spec) =>
        spec.subsystemDeviceId === bus.pciSubsystemDeviceId &&
        spec.deviceIds.includes(bus.pciDeviceId),
    ) ?? null
  );
}

/** Detector das placas Gigabyte com RGB Fusion no barramento I2C da GPU. */
export const nvidiaGpuFusionDetector: ControllerDetector = {
  name: 'Gigabyte RGB Fusion (GPU)',

  detect(ctx: DetectionContext): Controller[] {
    const controllers: Controller[] = [];

    for (const bus of ctx.gpu) {
      if (!hasPciIdentity(bus)) {
        ctx.log(`${bus.name}: barramento sem identidade PCI — nao da para identificar a placa`);
        continue;
      }

      const spec = matchGpu(bus);
      if (!spec) {
        const hex = (v: number): string => v.toString(16).padStart(4, '0').toUpperCase();
        ctx.log(
          `${bus.name}: ${hex(bus.pciVendorId)}:${hex(bus.pciDeviceId)} ` +
            `subsistema ${hex(bus.pciSubsystemVendorId)}:${hex(bus.pciSubsystemDeviceId)} ` +
            `nao esta na tabela de placas suportadas`,
        );
        continue;
      }

      const firmware = probeFusionController(bus, spec.address, ctx.log);
      if (firmware === null) continue;

      ctx.log(
        `${spec.name} confirmado em 0x${spec.address.toString(16)} ` +
          `(firmware 0x${firmware.toString(16)})`,
      );

      controllers.push(
        new GigabyteFusionGpuController(bus, spec.address, spec.name, firmware, bus.gpuIndex),
      );
    }

    return controllers;
  },
};

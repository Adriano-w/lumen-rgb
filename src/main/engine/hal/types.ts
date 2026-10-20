/*
 * Lumen — controle de iluminacao RGB
 * Copyright (C) 2026
 *
 * Este programa e software livre sob a GNU General Public License v2 ou
 * posterior. Veja o arquivo LICENSE.
 *
 * Partes dos drivers de protocolo derivam do OpenRGB (GPL-2.0-or-later).
 */

/**
 * Camada de abstracao de hardware do Lumen.
 *
 * Duas familias de interface:
 *  - **transportes** (`SmbusBus`, `HidBus`, `I2cBus`): como os bytes chegam ao
 *    device. Um transporte nao sabe nada sobre RGB.
 *  - **controllers**: um protocolo de iluminacao concreto. Um controller sabe
 *    falar com uma familia de hardware e nada mais.
 *
 * O detector cruza os dois: varre os transportes, pergunta a cada controller
 * registrado se aquele endereco e dele, e instancia os que responderem.
 */
import type { DeviceType, RGB, TransportKind } from '../../../shared/types.js';

/* ------------------------------------------------------------------ *
 * Transportes                                                        *
 * ------------------------------------------------------------------ */

/** Tamanhos de transacao SMBus (ABI do kernel Linux). */
export const SMBUS_SIZE = {
  QUICK: 0,
  BYTE: 1,
  BYTE_DATA: 2,
  WORD_DATA: 3,
  PROC_CALL: 4,
  BLOCK_DATA: 5,
  I2C_BLOCK_BROKEN: 6,
  BLOCK_PROC_CALL: 7,
  I2C_BLOCK_DATA: 8,
} as const;

export interface SmbusBus {
  /** Nome legivel, usado no `location` do device. */
  readonly name: string;

  readByte(addr: number): number;
  readByteData(addr: number, command: number): number;
  readWordData(addr: number, command: number): number;
  readBlockData(addr: number, command: number): Uint8Array;

  writeByte(addr: number, value: number): void;
  writeByteData(addr: number, command: number, value: number): void;
  writeWordData(addr: number, command: number, value: number): void;
  writeBlockData(addr: number, command: number, data: Uint8Array): void;

  /**
   * True se houver um device respondendo no endereco. Usa leitura, nunca
   * escrita — uma varredura que escreve pode corromper o SPD da memoria.
   */
  probe(addr: number): boolean;
}

export interface HidDeviceInfo {
  path: string;
  vendorId: number;
  productId: number;
  /** Numero da interface USB, quando o device e composto. */
  interfaceNumber: number;
  usagePage?: number;
  usage?: number;
  product?: string;
  manufacturer?: string;
  serialNumber?: string;
}

export interface HidConnection {
  write(data: readonly number[]): number;
  /** Feature report, usado pela maioria dos teclados e mouses RGB. */
  sendFeatureReport(data: readonly number[]): number;
  getFeatureReport(reportId: number, length: number): number[];
  readTimeout(timeoutMs: number): number[];
  close(): void;
}

export interface HidBus {
  enumerate(): HidDeviceInfo[];
  open(path: string): HidConnection;
}

/** I2C de GPU (NVAPI na NVIDIA, ADL na AMD). */
export interface I2cBus {
  readonly name: string;
  read(addr: number, command: number, length: number): Uint8Array;
  write(addr: number, command: number, data: Uint8Array): void;
  probe(addr: number): boolean;
}

/* ------------------------------------------------------------------ *
 * Controllers                                                        *
 * ------------------------------------------------------------------ */

/** Modo executado pelo firmware do proprio device. */
export interface ControllerMode {
  name: string;
  /** Valor no fio; cada protocolo define o seu. */
  value: number;
  /** O modo aceita uma cor por LED (ou seja, serve ao motor de efeitos). */
  perLed: boolean;
  speed?: { min: number; max: number; default: number };
  brightness?: { min: number; max: number; default: number };
  /** Quantas cores o modo aceita. 0 = gera as proprias. */
  colorsMin: number;
  colorsMax: number;
  directions?: readonly string[];
}

export interface ControllerZone {
  name: string;
  type: 'single' | 'linear' | 'matrix';
  ledCount: number;
  /** Faixa permitida, quando a zona aceita redimensionamento. */
  ledsMin?: number;
  ledsMax?: number;
}

/**
 * Um device de iluminacao concreto.
 *
 * Implementacoes NAO devem fazer IO no construtor: o detector constroi muitos
 * candidatos e descarta os que nao responderem.
 */
export interface Controller {
  /** Identidade estavel entre reinicios. Nunca derive de indice. */
  readonly id: string;
  readonly name: string;
  readonly vendor: string;
  readonly type: DeviceType;
  /** Onde ele esta: endereco SMBus, caminho HID, barramento da GPU. */
  readonly location: string;
  /**
   * Por onde os bytes passam. Define o teto de taxa de atualizacao.
   *
   * Declarado pelo driver de proposito: inferir isso a partir do texto de
   * `location` ja produziu bug — um driver reescreveu a propria mensagem e a
   * placa-mae passou a ser atualizada a 20 fps em vez de 8.
   */
  readonly transport: TransportKind;
  readonly version: string;
  readonly serial: string;

  readonly zones: readonly ControllerZone[];
  readonly modes: readonly ControllerMode[];
  readonly ledCount: number;
  /** Nome de cada LED, para a UI. */
  readonly ledNames: readonly string[];

  /** Indice do modo que aceita escrita por LED, se houver. */
  readonly directModeIndex?: number;

  /**
   * True quando o firmware grava na flash a cada escrita de cor.
   *
   * O ASRock Polychrome v2 faz isso: nao existe comando de save porque ele
   * salva sozinho. A consequencia e que efeitos em software, que reescrevem
   * continuamente, consomem ciclos de escrita de uma flash finita — enquanto
   * os modos do proprio firmware rodam dentro do chip e nao custam nada.
   *
   * Quem consome esta flag deve reduzir a taxa de atualizacao e deixar claro
   * ao usuario que ha um custo.
   */
  readonly writeWearRisk?: boolean;

  /** Modo ativo no device agora. */
  getActiveMode(): number;

  /** Troca o modo de firmware e seus parametros. */
  setMode(modeIndex: number, options: SetModeOptions): void;

  /** Pinta todos os LEDs. `colors.length === ledCount`. */
  updateLeds(colors: readonly RGB[]): void;

  /** Pinta uma zona. `colors.length === zones[zoneIndex].ledCount`. */
  updateZoneLeds(zoneIndex: number, colors: readonly RGB[]): void;

  /** Redimensiona uma zona de tamanho configuravel (header ARGB). */
  resizeZone?(zoneIndex: number, ledCount: number): void;

  /** Grava o estado na flash do controller. Desgasta: so a pedido explicito. */
  save?(): void;

  /** Libera recursos (handles HID, por exemplo). */
  close(): void;
}

export interface SetModeOptions {
  colors?: readonly RGB[];
  speed?: number;
  brightness?: number;
  direction?: number;
}

/* ------------------------------------------------------------------ *
 * Deteccao                                                           *
 * ------------------------------------------------------------------ */

export interface DetectionContext {
  /** Barramentos SMBus disponiveis. Vazio quando falta PawnIO ou elevacao. */
  smbus: readonly SmbusBus[];
  hid: HidBus;
  /** Barramentos I2C de GPU. Vazio quando nao ha GPU suportada. */
  gpu: readonly I2cBus[];
  log: (msg: string) => void;
}

/**
 * Um detector por familia de protocolo.
 *
 * Deve ser conservador: encostar num endereco errado no SMBus pode escrever em
 * lugar nenhum de bom. Identifique por assinatura antes de assumir o device.
 */
export interface ControllerDetector {
  /** Nome da familia, para log e diagnostico. */
  readonly name: string;
  detect(ctx: DetectionContext): Promise<Controller[]> | Controller[];
}

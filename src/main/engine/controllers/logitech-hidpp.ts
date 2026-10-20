/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 *
 * Portado do OpenRGB (GPL-2.0-or-later):
 *   - Controllers/LogitechController/LogitechProtocolCommon.cpp e .h
 *     (enquadramento RAP/FAP, descoberta de feature index, enumeracao de
 *     devices pareados no receptor, paginas RGB 0x8070 e 0x8071)
 *   - Controllers/LogitechController/LogitechControllerDetect.cpp
 *     (quais PIDs, interfaces e usages identificam cada familia)
 *   - Controllers/LogitechController/LogitechLightspeedController/
 *     LogitechLightspeedController.cpp e RGBController_LogitechLightspeed.cpp
 *     (montagem de modos e zonas a partir dos efeitos que o device anuncia)
 */

/**
 * Devices Logitech que falam HID++ 2.0 com pagina de efeitos RGB.
 *
 * Duas topologias, um protocolo:
 *
 *  - **Cabeado / direto.** O device aparece sozinho na arvore HID e responde
 *    no indice 0xFF. E o caso do G733: PID 0x0AB5, interface 3, usage page
 *    0xFF43 usage 0x0202.
 *
 *  - **Pelo receptor Lightspeed.** O que aparece na arvore HID e o receptor
 *    (PID 0xC539), nao o mouse. O mouse e um device *pareado*, enderecado por
 *    um indice de 1 a 6 dentro das mensagens. Mandar o pacote para o indice
 *    0xFF conversa com o receptor e o mouse nunca ve nada. Por isso a deteccao
 *    pergunta ao receptor quem esta pareado antes de falar com qualquer um.
 *
 * O Windows quebra cada interface em varias colecoes HID, uma por usage, cada
 * uma com seu proprio caminho. O protocolo usa duas delas: a de mensagem curta
 * (usage 1, relatorio 0x10, 7 bytes) para os registradores do receptor, e a de
 * mensagem longa (usage 2, relatorio 0x11, 20 bytes) para o HID++ 2.0.
 */
import type { RGB } from '../../../shared/types.js';
import type {
  Controller,
  ControllerDetector,
  ControllerMode,
  ControllerZone,
  DetectionContext,
  HidConnection,
  HidDeviceInfo,
  SetModeOptions,
} from '../hal/types.js';

/* ------------------------------------------------------------------ *
 * Constantes do protocolo                                            *
 * ------------------------------------------------------------------ */

const LOGITECH_VID = 0x046d;

const REPORT_SHORT = 0x10;
const REPORT_SHORT_LEN = 7;
const REPORT_LONG = 0x11;
const REPORT_LONG_LEN = 20;

/** Indice que endereca o proprio receptor, ou um device cabeado. */
const DEVICE_INDEX_SELF = 0xff;

/** Sub-ids do RAP (protocolo de registradores, usado so com o receptor). */
const RAP_SET_REGISTER = 0x80;
const RAP_GET_REGISTER = 0x81;
const RAP_GET_LONG_REGISTER = 0x83;

/** Registradores do receptor. */
const REG_ENABLE_NOTIFICATIONS = 0x00;
const REG_CONNECTION_STATE = 0x02;
const REG_PAIRING_INFO = 0xb5;

/** Paginas de feature do HID++ 2.0. */
const PAGE_ROOT = 0x0000;
const PAGE_DEVICE_NAME_TYPE = 0x0005;
const PAGE_RGB_EFFECTS_8070 = 0x8070;
const PAGE_RGB_EFFECTS_8071 = 0x8071;

const CMD_ROOT_GET_FEATURE = 0x01;
const CMD_ROOT_GET_PROTOCOL = 0x11;

const CMD_NAME_GET_COUNT = 0x01;
const CMD_NAME_GET_NAME = 0x11;
const CMD_NAME_GET_TYPE = 0x21;

/** Comandos da pagina 0x8070. */
const FP8070_GET_COUNT = 0x00;
const FP8070_GET_INFO = 0x10;
const FP8070_GET_CONTROL = 0x20;
const FP8070_SET_EFFECT = 0x30;
const FP8070_SET_SW_CTL = 0x80;

/** Comandos da pagina 0x8071. */
const FP8071_SET_LED_EFFECT = 0x10;
const FP8071_CONTROL = 0x50;

/** Modos de iluminacao, como o firmware os numera. */
const FX_OFF = 0x0000;
const FX_ON = 0x0001;
const FX_SPECTRUM = 0x0003;
const FX_BREATHING = 0x000a;

/**
 * Faixa de velocidade. Atencao: no fio, MENOR e MAIS RAPIDO.
 *
 * O OpenRGB expoe isso como `speed_min = 0xC8` e `speed_max = 0x0A`, ou seja,
 * min maior que max. Aqui o contrato exige `min <= max`, entao invertemos os
 * nomes e deixamos o aviso: um slider que sobe deixa o efeito mais lento.
 */
const SPEED_FASTEST = 0x0a;
const SPEED_NORMAL = 0x32;
const SPEED_SLOWEST = 0xc8;

const BRIGHTNESS_MIN = 0x01;
const BRIGHTNESS_MAX = 0x64;

/** Timeout de resposta a uma pergunta. O OpenRGB usa o mesmo valor. */
const REPLY_TIMEOUT_MS = 300;

/**
 * Timeout para drenar a confirmacao de um comando de pintura.
 *
 * Todo SET do HID++ responde. Se nunca lermos, a fila do hidapi enche e as
 * respostas seguintes chegam desalinhadas. Mas esperar 300 ms por zona
 * inviabilizaria o motor de efeitos, entao aqui so limpamos o que ja chegou.
 */
const DRAIN_TIMEOUT_MS = 4;

/** Resposta de erro do HID++ 1.0 e 2.0, respectivamente. */
const ERROR_HIDPP10 = 0x8f;
const ERROR_HIDPP20 = 0xff;

/** Nomes de posicao de LED. O indice e o valor que o device reporta. */
const LED_LOCATIONS = [
  'Unknown',
  'Primary',
  'Logo',
  'Left',
  'Right',
  'Combined',
  'Group One',
  'Group Two',
  'Group Three',
  'Group Four',
  'Group Five',
  'Group Six',
] as const;

/* ------------------------------------------------------------------ *
 * Catalogo de hardware                                               *
 * ------------------------------------------------------------------ */

interface ReceiverSpec {
  pid: number;
  interfaceNumber: number;
  usagePage: number;
  label: string;
}

/** Receptores que hospedam devices pareados. */
const RECEIVERS: readonly ReceiverSpec[] = [
  { pid: 0xc539, interfaceNumber: 2, usagePage: 0xff00, label: 'Receptor Logitech G Lightspeed' },
  { pid: 0xc53a, interfaceNumber: 2, usagePage: 0xff00, label: 'Logitech G Powerplay' },
];

interface DirectSpec {
  pid: number;
  interfaceNumber: number;
  usagePage: number;
  usage: number;
  label: string;
}

/**
 * Devices que respondem direto, sem receptor.
 *
 * O G733 usa uma pagina de usage propria (0xFF43 / 0x0202) em vez da 0xFF00
 * padrao. Como o indice interno de usage e o byte baixo do usage, 0x0202 cai
 * na chave 2 — a mesma da mensagem longa. Isso nao e coincidencia feliz: e do
 * que o protocolo depende para funcionar, e e por isso que mascaramos.
 */
const DIRECT_DEVICES: readonly DirectSpec[] = [
  { pid: 0x0ab5, interfaceNumber: 3, usagePage: 0xff43, usage: 0x0202, label: 'Logitech G733 Gaming Headset' },
  { pid: 0x0afe, interfaceNumber: 3, usagePage: 0xff43, usage: 0x0202, label: 'Logitech G733 Gaming Headset' },
  { pid: 0x0b1f, interfaceNumber: 3, usagePage: 0xff43, usage: 0x0202, label: 'Logitech G733 Gaming Headset' },
];

/** Tipos de device do HID++, mapeados para a taxonomia do Lumen. */
const LOGITECH_TYPE_TO_LUMEN = [
  'keyboard', // 0
  'accessory', // 1 remote control
  'keypad', // 2 numpad
  'mouse', // 3
  'mousemat', // 4
  'mouse', // 5 trackball
  'accessory', // 6 presenter
  'unknown', // 7 receiver
  'headset', // 8
] as const;

/* ------------------------------------------------------------------ *
 * Transporte                                                         *
 * ------------------------------------------------------------------ */

/** Um quadro HID++ ja decomposto. */
interface HidppFrame {
  reportId: number;
  deviceIndex: number;
  featureIndex: number;
  featureCommand: number;
  data: number[];
}

function parseFrame(raw: readonly number[]): HidppFrame | null {
  if (raw.length < 4) return null;
  return {
    reportId: raw[0]!,
    deviceIndex: raw[1]!,
    featureIndex: raw[2]!,
    featureCommand: raw[3]!,
    data: raw.slice(4),
  };
}

/**
 * As colecoes HID de uma interface, compartilhadas por quem estiver nela.
 *
 * Um receptor Powerplay pode hospedar o mouse e o mousepad ao mesmo tempo, e
 * ambos saem pelas mesmas colecoes. O contador de referencia evita que fechar
 * um controller derrube o outro.
 */
class LogitechTransport {
  private refs = 1;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly connections: Map<number, HidConnection>,
  ) {}

  retain(): void {
    this.refs++;
  }

  private connection(usageIndex: number): HidConnection | null {
    return this.connections.get(usageIndex) ?? null;
  }

  /** Colecao de mensagem longa (0x11). E onde vive o HID++ 2.0. */
  get long(): HidConnection | null {
    return this.connection(2);
  }

  /** Colecao de mensagem curta (0x10). E onde vivem os registradores. */
  get short(): HidConnection | null {
    return this.connection(1);
  }

  /** Esvazia a fila de leitura. Chamado antes de qualquer pergunta. */
  flush(): void {
    for (const conn of this.connections.values()) {
      for (let i = 0; i < 64; i++) {
        if (conn.readTimeout(1).length === 0) break;
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.refs--;
    if (this.refs > 0) return;
    this.closed = true;
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}

/** Monta um relatorio curto (RAP). */
function shortRequest(
  deviceIndex: number,
  subId: number,
  register: number,
  data: readonly number[] = [],
): number[] {
  const buf = new Array<number>(REPORT_SHORT_LEN).fill(0);
  buf[0] = REPORT_SHORT;
  buf[1] = deviceIndex;
  buf[2] = subId;
  buf[3] = register;
  for (let i = 0; i < data.length && 4 + i < REPORT_SHORT_LEN; i++) {
    buf[4 + i] = data[i]!;
  }
  return buf;
}

/** Monta um relatorio longo (FAP, HID++ 2.0). */
function longRequest(
  deviceIndex: number,
  featureIndex: number,
  featureCommand: number,
  data: readonly number[] = [],
): number[] {
  const buf = new Array<number>(REPORT_LONG_LEN).fill(0);
  buf[0] = REPORT_LONG;
  buf[1] = deviceIndex;
  buf[2] = featureIndex;
  buf[3] = featureCommand;
  for (let i = 0; i < data.length && 4 + i < REPORT_LONG_LEN; i++) {
    buf[4 + i] = data[i]!;
  }
  return buf;
}

/**
 * Escreve e espera a resposta correspondente.
 *
 * O device intercala notificacoes espontaneas (bateria, botao, link) com as
 * respostas. Filtramos por indice/feature/comando e descartamos o resto, com
 * um orcamento de leituras para nunca travar.
 */
function request(
  conn: HidConnection,
  packet: readonly number[],
  match: { deviceIndex: number; featureIndex: number; featureCommand: number },
  timeoutMs = REPLY_TIMEOUT_MS,
): HidppFrame | null {
  try {
    conn.write(packet);
  } catch {
    return null;
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = conn.readTimeout(timeoutMs);
    if (raw.length === 0) return null;

    const frame = parseFrame(raw);
    if (!frame) continue;

    // Erro: o device responde com 0x8F (HID++ 1.0) ou 0xFF (2.0) no lugar do
    // feature index, e o indice que falhou no byte seguinte.
    if (
      (frame.featureIndex === ERROR_HIDPP10 || frame.featureIndex === ERROR_HIDPP20) &&
      frame.deviceIndex === match.deviceIndex
    ) {
      return null;
    }

    if (
      frame.deviceIndex === match.deviceIndex &&
      frame.featureIndex === match.featureIndex &&
      frame.featureCommand === match.featureCommand
    ) {
      return frame;
    }
  }

  return null;
}

/** Envia sem esperar: so drena o que ja estiver na fila. */
function fireAndDrain(conn: HidConnection, packet: readonly number[]): void {
  try {
    conn.write(packet);
    conn.readTimeout(DRAIN_TIMEOUT_MS);
  } catch {
    // Device sumiu no meio de um frame de efeito. O proximo ciclo descobre.
  }
}

/* ------------------------------------------------------------------ *
 * Consultas HID++ 2.0                                                *
 * ------------------------------------------------------------------ */

/** Traduz uma pagina de feature para o indice que este device usa. */
function getFeatureIndex(conn: HidConnection, deviceIndex: number, page: number): number {
  const frame = request(
    conn,
    longRequest(deviceIndex, PAGE_ROOT, CMD_ROOT_GET_FEATURE, [(page >> 8) & 0xff, page & 0xff]),
    { deviceIndex, featureIndex: PAGE_ROOT, featureCommand: CMD_ROOT_GET_FEATURE },
  );
  return frame ? frame.data[0]! : 0;
}

function getProtocolVersion(conn: HidConnection, deviceIndex: number): string {
  const frame = request(
    conn,
    longRequest(deviceIndex, PAGE_ROOT, CMD_ROOT_GET_PROTOCOL),
    { deviceIndex, featureIndex: PAGE_ROOT, featureCommand: CMD_ROOT_GET_PROTOCOL },
  );
  if (!frame) return '';
  return `HID++ ${frame.data[0]}.${frame.data[1]}`;
}

interface DeviceIdentity {
  name: string;
  logitechType: number;
}

/** Le o nome e o tipo que o proprio device reporta (pagina 0x0005). */
function getDeviceIdentity(conn: HidConnection, deviceIndex: number): DeviceIdentity | null {
  const featureIndex = getFeatureIndex(conn, deviceIndex, PAGE_DEVICE_NAME_TYPE);
  if (featureIndex === 0) return null;

  const lengthFrame = request(
    conn,
    longRequest(deviceIndex, featureIndex, CMD_NAME_GET_COUNT),
    { deviceIndex, featureIndex, featureCommand: CMD_NAME_GET_COUNT },
  );
  if (!lengthFrame) return null;

  const nameLength = lengthFrame.data[0]!;
  if (nameLength === 0 || nameLength > 64) return null;

  let name = '';
  // O nome vem em pedacos de 16 caracteres; pedimos a partir do que ja temos.
  for (let guard = 0; name.length < nameLength && guard < 8; guard++) {
    const chunk = request(
      conn,
      longRequest(deviceIndex, featureIndex, CMD_NAME_GET_NAME, [name.length]),
      { deviceIndex, featureIndex, featureCommand: CMD_NAME_GET_NAME },
    );
    if (!chunk) break;

    let piece = '';
    for (const byte of chunk.data) {
      if (byte === 0) break;
      piece += String.fromCharCode(byte);
    }
    if (piece.length === 0) break;
    name += piece;
  }

  name = name.slice(0, nameLength).trim();
  if (name.length === 0) return null;

  const typeFrame = request(
    conn,
    longRequest(deviceIndex, featureIndex, CMD_NAME_GET_TYPE),
    { deviceIndex, featureIndex, featureCommand: CMD_NAME_GET_TYPE },
  );

  return { name, logitechType: typeFrame ? typeFrame.data[0]! : 0xff };
}

/** Um efeito que o LED anuncia suportar. */
interface LedEffect {
  /** Posicao na tabela do device. E o que vai no fio. */
  index: number;
  /** Modo de firmware (FX_ON, FX_SPECTRUM, ...). */
  mode: number;
}

interface LedDescriptor {
  /** Indice do LED, como o device o numera. */
  index: number;
  /** Posicao fisica; vira o nome da zona. */
  location: number;
  effects: LedEffect[];
}

/**
 * Le a configuracao RGB da pagina 0x8070.
 *
 * Tres niveis: quantos LEDs existem, que posicao e quantos efeitos cada um
 * tem, e qual o modo de firmware de cada efeito.
 */
function readRgbConfig8070(
  conn: HidConnection,
  deviceIndex: number,
  featureIndex: number,
): LedDescriptor[] {
  const countFrame = request(
    conn,
    longRequest(deviceIndex, featureIndex, FP8070_GET_COUNT),
    { deviceIndex, featureIndex, featureCommand: FP8070_GET_COUNT },
  );
  if (!countFrame) return [];

  const ledCount = countFrame.data[0]!;
  if (ledCount === 0 || ledCount > 16) return [];

  const leds: LedDescriptor[] = [];

  for (let i = 0; i < ledCount; i++) {
    const infoFrame = request(
      conn,
      longRequest(deviceIndex, featureIndex, FP8070_GET_INFO, [i]),
      { deviceIndex, featureIndex, featureCommand: FP8070_GET_INFO },
    );
    if (!infoFrame) continue;

    // O OpenRGB descarta a resposta 0x10/0x02: e o device sinalizando que o
    // indice pedido nao existe, em vez de responder com erro.
    if (infoFrame.data[0] === 0x10 && infoFrame.data[1] === 0x02) continue;

    const location = (infoFrame.data[1]! << 8) | infoFrame.data[2]!;
    const effectCount = infoFrame.data[3]!;
    const effects: LedEffect[] = [];

    for (let fx = 0; fx < effectCount && fx < 16; fx++) {
      const fxFrame = request(
        conn,
        longRequest(deviceIndex, featureIndex, FP8070_GET_CONTROL, [i, fx]),
        { deviceIndex, featureIndex, featureCommand: FP8070_GET_CONTROL },
      );
      if (!fxFrame) continue;

      effects.push({ index: fx, mode: (fxFrame.data[2]! << 8) | fxFrame.data[3]! });
    }

    leds.push({ index: infoFrame.data[0]!, location, effects });
  }

  return leds;
}

/**
 * Le a configuracao RGB da pagina 0x8071.
 *
 * Nenhum dos devices alvo deste build usa esta pagina; ela esta aqui porque a
 * familia e a mesma e o custo e baixo. Se algum hardware cair neste caminho,
 * vale conferir no fio antes de confiar.
 */
function readRgbConfig8071(
  conn: HidConnection,
  deviceIndex: number,
  featureIndex: number,
): LedDescriptor[] {
  const countFrame = request(
    conn,
    longRequest(deviceIndex, featureIndex, FP8070_GET_COUNT, [0xff, 0xff, 0, 0, 0]),
    { deviceIndex, featureIndex, featureCommand: FP8070_GET_COUNT },
  );
  if (!countFrame) return [];

  const ledCount = (countFrame.data[1]! << 8) | countFrame.data[2]!;
  if (ledCount === 0 || ledCount > 16) return [];

  const leds: LedDescriptor[] = [];

  for (let i = 0; i < ledCount; i++) {
    const infoFrame = request(
      conn,
      longRequest(deviceIndex, featureIndex, FP8070_GET_COUNT, [i, 0xff, 0]),
      { deviceIndex, featureIndex, featureCommand: FP8070_GET_COUNT },
    );
    if (!infoFrame) continue;

    const location = (infoFrame.data[2]! << 8) | infoFrame.data[3]!;
    const effectCount = infoFrame.data[4]!;
    const effects: LedEffect[] = [];

    for (let fx = 0; fx < effectCount && fx < 16; fx++) {
      const fxFrame = request(
        conn,
        longRequest(deviceIndex, featureIndex, FP8070_GET_COUNT, [i, fx]),
        { deviceIndex, featureIndex, featureCommand: FP8070_GET_COUNT },
      );
      if (!fxFrame) continue;
      effects.push({ index: fx, mode: (fxFrame.data[2]! << 8) | fxFrame.data[3]! });
    }

    leds.push({ index: infoFrame.data[0]!, location, effects });
  }

  return leds;
}

/* ------------------------------------------------------------------ *
 * Receptor: quem esta pareado                                        *
 * ------------------------------------------------------------------ */

interface PairedDevice {
  deviceIndex: number;
  /** PID "virtual" do device pareado, nao o do receptor. */
  virtualPid: number;
  online: boolean;
}

/**
 * Pergunta ao receptor quais devices estao pareados.
 *
 * O truque e o do driver do kernel: escrever 0x02 no registrador de estado de
 * conexao faz o receptor simular uma reconexao e anunciar cada device pareado
 * numa notificacao. Lemos uma notificacao por device, mais uma do proprio
 * receptor.
 */
function enumeratePairedDevices(transport: LogitechTransport): PairedDevice[] {
  const conn = transport.short;
  if (!conn) return [];

  // Ligar as notificacoes sem fio, se ainda nao estiverem.
  const notifyState = request(
    conn,
    shortRequest(DEVICE_INDEX_SELF, RAP_GET_REGISTER, REG_ENABLE_NOTIFICATIONS),
    { deviceIndex: DEVICE_INDEX_SELF, featureIndex: RAP_GET_REGISTER, featureCommand: REG_ENABLE_NOTIFICATIONS },
  );

  if (!notifyState || (notifyState.data[1]! & 1) === 0) {
    request(
      conn,
      shortRequest(DEVICE_INDEX_SELF, RAP_SET_REGISTER, REG_ENABLE_NOTIFICATIONS, [0, 1]),
      { deviceIndex: DEVICE_INDEX_SELF, featureIndex: RAP_SET_REGISTER, featureCommand: REG_ENABLE_NOTIFICATIONS },
    );
  }

  const stateFrame = request(
    conn,
    shortRequest(DEVICE_INDEX_SELF, RAP_GET_REGISTER, REG_CONNECTION_STATE),
    { deviceIndex: DEVICE_INDEX_SELF, featureIndex: RAP_GET_REGISTER, featureCommand: REG_CONNECTION_STATE },
  );
  if (!stateFrame) return [];

  const pairedCount = stateFrame.data[1]!;
  if (pairedCount === 0 || pairedCount > 6) return [];

  try {
    conn.write(shortRequest(DEVICE_INDEX_SELF, RAP_SET_REGISTER, REG_CONNECTION_STATE, [0x02]));
  } catch {
    return [];
  }

  const found: PairedDevice[] = [];
  // +1 porque o receptor tambem se anuncia; +2 de folga para notificacoes
  // espontaneas que cheguem no meio.
  const budget = pairedCount + 3;

  for (let i = 0; i < budget && found.length < pairedCount; i++) {
    const raw = conn.readTimeout(REPLY_TIMEOUT_MS);
    if (raw.length === 0) break;

    const frame = parseFrame(raw);
    if (!frame) continue;
    if (frame.deviceIndex === DEVICE_INDEX_SELF) continue;
    if (found.some((d) => d.deviceIndex === frame.deviceIndex)) continue;

    found.push({
      deviceIndex: frame.deviceIndex,
      virtualPid: (frame.data[2]! << 8) | frame.data[1]!,
      // Bit 0x40 ligado = pareado mas sem link: o device esta dormindo.
      online: (frame.data[0]! & 0x40) === 0,
    });
  }

  return found;
}

/** Serial que o receptor guarda do slot pareado. Funciona com o device off. */
function getPairingSerial(transport: LogitechTransport, deviceIndex: number): string {
  const conn = transport.short;
  if (!conn || deviceIndex < 1) return '';

  const sub = (0x30 + deviceIndex - 1) & 0xff;
  const frame = request(
    conn,
    shortRequest(DEVICE_INDEX_SELF, RAP_GET_LONG_REGISTER, REG_PAIRING_INFO, [sub]),
    { deviceIndex: DEVICE_INDEX_SELF, featureIndex: RAP_GET_LONG_REGISTER, featureCommand: REG_PAIRING_INFO },
  );
  if (!frame || frame.data[0] !== sub) return '';

  const serial = [frame.data[1], frame.data[2], frame.data[3], frame.data[4]]
    .map((b) => (b ?? 0).toString(16).padStart(2, '0').toUpperCase())
    .join('');

  // Serial zerado e o receptor dizendo que nao tem nenhum.
  return serial === '00000000' ? '' : serial;
}

/* ------------------------------------------------------------------ *
 * Controller                                                         *
 * ------------------------------------------------------------------ */

/** Um modo pronto, com o que o fio precisa guardado junto. */
interface LogitechMode extends ControllerMode {
  /** Modo de firmware (FX_*). Decide quais bytes do pacote valem. */
  readonly firmwareMode: number;
  /** True quando este e o modo "Direct" (controle por software). */
  readonly isDirect: boolean;
}

interface ControllerInit {
  id: string;
  name: string;
  type: string;
  location: string;
  version: string;
  serial: string;
  transport: LogitechTransport;
  deviceIndex: number;
  rgbFeatureIndex: number;
  featurePage: number;
  leds: LedDescriptor[];
  modes: LogitechMode[];
  directModeIndex: number | undefined;
}

class LogitechHidppController implements Controller {
  readonly id: string;
  readonly name: string;
  readonly vendor = 'Logitech';
  readonly type: Controller['type'];
  readonly location: string;
  /** Periferico por HID++: dedicado e rapido, aguenta 30 fps. */
  readonly transport = 'hid' as const;
  readonly version: string;
  readonly serial: string;
  readonly zones: readonly ControllerZone[];
  readonly modes: readonly LogitechMode[];
  readonly ledCount: number;
  readonly ledNames: readonly string[];
  readonly directModeIndex: number | undefined;

  /** Canal HID++ (receptor ou conexao direta). Nao confundir com `transport`,
   * que e a classe de barramento exigida pela interface Controller. */
  private readonly link: LogitechTransport;
  private readonly deviceIndex: number;
  private readonly rgbFeatureIndex: number;
  private readonly isPage8070: boolean;
  private readonly ledIndices: number[];

  private activeMode = 0;
  private speed = SPEED_NORMAL;
  private brightness = BRIGHTNESS_MAX;
  /** Ultima cor escrita por zona. Evita reenviar o que nao mudou. */
  private readonly lastColors: (number | null)[];
  private closed = false;

  constructor(init: ControllerInit) {
    this.id = init.id;
    this.name = init.name;
    this.type = init.type as Controller['type'];
    this.location = init.location;
    this.version = init.version;
    this.serial = init.serial;
    this.link = init.transport;
    this.deviceIndex = init.deviceIndex;
    this.rgbFeatureIndex = init.rgbFeatureIndex;
    this.isPage8070 = init.featurePage === PAGE_RGB_EFFECTS_8070;
    this.modes = init.modes;
    this.directModeIndex = init.directModeIndex;

    this.ledIndices = init.leds.map((led) => led.index);
    this.ledCount = init.leds.length;
    this.lastColors = new Array<number | null>(this.ledCount).fill(null);

    const zones: ControllerZone[] = [];
    const ledNames: string[] = [];

    init.leds.forEach((led, position) => {
      const place =
        led.location < LED_LOCATIONS.length ? LED_LOCATIONS[led.location]! : `Zone ${position}`;
      zones.push({ name: `${place} Zone`, type: 'single', ledCount: 1, ledsMin: 1, ledsMax: 1 });
      ledNames.push(`${place} LED`);
    });

    this.zones = zones;
    this.ledNames = ledNames;
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
      this.speed = Math.max(SPEED_FASTEST, Math.min(SPEED_SLOWEST, Math.round(options.speed)));
    }
    if (typeof options.brightness === 'number') {
      this.brightness = Math.max(
        BRIGHTNESS_MIN,
        Math.min(BRIGHTNESS_MAX, Math.round(options.brightness)),
      );
    }

    // Trocar o controle por software e caro e so faz sentido na troca de modo.
    // Durante um efeito, pintar e so mandar a cor.
    this.setSoftwareControl(mode.isDirect);

    // Forca o reenvio: o modo mudou, as cores antigas nao valem mais.
    this.lastColors.fill(null);

    const colors = options.colors;
    if (colors && colors.length > 0) {
      const painted: RGB[] = [];
      for (let i = 0; i < this.ledCount; i++) {
        painted.push(colors[i] ?? colors[0]!);
      }
      this.updateLeds(painted);
    } else {
      // Modos sem cor (Off, Spectrum Cycle) ainda precisam do pacote para
      // entrar em vigor; mandamos preto como cor de acompanhamento.
      for (let i = 0; i < this.ledCount; i++) {
        this.sendZone(i, { r: 0, g: 0, b: 0 }, true);
      }
    }
  }

  updateLeds(colors: readonly RGB[]): void {
    if (this.closed) return;
    for (let i = 0; i < this.ledCount; i++) {
      const color = colors[i];
      if (color) this.sendZone(i, color, false);
    }
  }

  updateZoneLeds(zoneIndex: number, colors: readonly RGB[]): void {
    if (this.closed) return;
    const color = colors[0];
    if (!color) return;
    this.sendZone(zoneIndex, color, false);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.link.close();
  }

  /* ---------------------------------------------------------------- *
   * Fio                                                              *
   * ---------------------------------------------------------------- */

  /**
   * Liga ou desliga o controle por software.
   *
   * Com ele ligado o firmware para de rodar efeitos proprios e aceita cores
   * cruas — e o que o modo Direct precisa.
   */
  private setSoftwareControl(enabled: boolean): void {
    const conn = this.link.long;
    if (!conn) return;

    if (this.isPage8070) {
      const flag = enabled ? 1 : 0;
      fireAndDrain(
        conn,
        longRequest(this.deviceIndex, this.rgbFeatureIndex, FP8070_SET_SW_CTL, [flag, flag]),
      );
    } else {
      // 0x8071: data[1] = 3 tira do firmware o controle de RGB e de energia.
      fireAndDrain(
        conn,
        longRequest(this.deviceIndex, this.rgbFeatureIndex, FP8071_CONTROL, [
          1,
          3,
          enabled ? 5 : 0,
        ]),
      );
    }
  }

  /**
   * Pinta uma zona.
   *
   * Um pacote por zona. Com duas zonas e o motor a 30 fps sao 60 escritas por
   * segundo, acima do que esses devices aguentam — por isso pulamos a zona cuja
   * cor nao mudou, que na pratica derruba muito esse numero. Nao ha retry: se o
   * pacote se perder, o proximo quadro corrige.
   */
  private sendZone(zonePosition: number, color: RGB, force: boolean): void {
    const conn = this.link.long;
    if (!conn) return;

    const mode = this.modes[this.activeMode];
    if (!mode) return;

    const packed = (color.r << 16) | (color.g << 8) | color.b;
    if (!force && this.lastColors[zonePosition] === packed) return;
    this.lastColors[zonePosition] = packed;

    const ledIndex = this.ledIndices[zonePosition];
    if (ledIndex === undefined) return;

    const command = this.isPage8070 ? FP8070_SET_EFFECT : FP8071_SET_LED_EFFECT;
    const data = new Array<number>(16).fill(0);

    data[0] = ledIndex;
    data[1] = mode.value; // indice do efeito na tabela do device
    data[2] = color.r & 0xff;
    data[3] = color.g & 0xff;
    data[4] = color.b & 0xff;
    // Bits 2-3 modo de energia, bits 0-1 persistencia.
    data[12] = this.isPage8070 ? 0x00 : 0x01;

    // O periodo vai em centesimos: 0x0A..0xC8 viram 1000..20000 ms.
    const period = this.speed * 100;

    switch (mode.firmwareMode) {
      case FX_SPECTRUM:
        data[7] = (period >> 8) & 0xff;
        data[8] = period & 0xff;
        data[9] = this.brightness;
        break;

      case FX_BREATHING:
        data[5] = (period >> 8) & 0xff;
        data[6] = period & 0xff;
        // data[7] seria a curva (0-6). O firmware usa a padrao com 0.
        data[8] = this.brightness;
        break;

      default:
        // FX_ON e FX_OFF nao levam parametro alem da cor.
        break;
    }

    fireAndDrain(conn, longRequest(this.deviceIndex, this.rgbFeatureIndex, command, data));
  }
}

/* ------------------------------------------------------------------ *
 * Montagem de modos                                                  *
 * ------------------------------------------------------------------ */

/**
 * Traduz os efeitos que o device anuncia para a lista de modos do Lumen.
 *
 * A ordem dos efeitos varia por device, entao o indice do fio nunca e
 * presumido: ele sai da tabela que o proprio device entregou. "Off" entra
 * sempre, mesmo que o device nao o liste, porque o desligado e o unico modo
 * que todo firmware desta familia aceita.
 */
function buildModes(leds: readonly LedDescriptor[]): {
  modes: LogitechMode[];
  directModeIndex: number | undefined;
} {
  const modes: LogitechMode[] = [];
  let directModeIndex: number | undefined;

  const speedRange = { min: SPEED_FASTEST, max: SPEED_SLOWEST, default: SPEED_NORMAL };
  const brightnessRange = {
    min: BRIGHTNESS_MIN,
    max: BRIGHTNESS_MAX,
    default: BRIGHTNESS_MAX,
  };

  modes.push({
    name: 'Off',
    value: 0,
    perLed: false,
    colorsMin: 0,
    colorsMax: 0,
    firmwareMode: FX_OFF,
    isDirect: false,
  });

  // Os modos descrevem o device inteiro; o LED 0 anuncia a mesma tabela que os
  // demais nos devices desta familia.
  const reference = leds[0];
  if (!reference) return { modes, directModeIndex };

  for (const effect of reference.effects) {
    switch (effect.mode) {
      case FX_OFF:
        // Ja esta na lista.
        break;

      case FX_ON: {
        directModeIndex = modes.length;
        modes.push({
          name: 'Direct',
          value: effect.index,
          perLed: true,
          colorsMin: 1,
          colorsMax: 1,
          firmwareMode: FX_ON,
          isDirect: true,
        });
        modes.push({
          name: 'Static',
          value: effect.index,
          perLed: true,
          colorsMin: 1,
          colorsMax: 1,
          brightness: brightnessRange,
          firmwareMode: FX_ON,
          isDirect: false,
        });
        break;
      }

      case FX_SPECTRUM:
        modes.push({
          name: 'Spectrum Cycle',
          value: effect.index,
          perLed: false,
          colorsMin: 0,
          colorsMax: 0,
          speed: speedRange,
          brightness: brightnessRange,
          firmwareMode: FX_SPECTRUM,
          isDirect: false,
        });
        break;

      case FX_BREATHING:
        modes.push({
          name: 'Breathing',
          value: effect.index,
          perLed: true,
          colorsMin: 1,
          colorsMax: 1,
          speed: speedRange,
          brightness: brightnessRange,
          firmwareMode: FX_BREATHING,
          isDirect: false,
        });
        break;

      default:
        // Wave, Star, Ripple e Custom existem no enum mas nao tem mapeamento
        // confiavel de parametros. Melhor nao oferecer do que oferecer errado.
        break;
    }
  }

  return { modes, directModeIndex };
}

/* ------------------------------------------------------------------ *
 * Deteccao                                                           *
 * ------------------------------------------------------------------ */

/** Chave de agrupamento: todas as colecoes de uma mesma interface fisica. */
function interfaceKey(info: HidDeviceInfo): string {
  return `${info.productId}:${info.interfaceNumber}`;
}

/**
 * Abre as colecoes de uma interface, indexadas pelo byte baixo do usage.
 *
 * O byte baixo e proposital: e assim que o protocolo enderecava as colecoes
 * antes de existir a pagina 0xFF43, e e o que faz o usage 0x0202 do G733 cair
 * na mesma chave 2 da mensagem longa padrao.
 */
function openUsages(
  ctx: DetectionContext,
  infos: readonly HidDeviceInfo[],
): Map<number, HidConnection> {
  const connections = new Map<number, HidConnection>();

  for (const info of infos) {
    if (info.usage === undefined) continue;
    const key = info.usage & 0xff;
    if (connections.has(key)) continue;

    try {
      connections.set(key, ctx.hid.open(info.path));
    } catch {
      ctx.log(`Logitech: nao consegui abrir ${info.path} (usage 0x${info.usage.toString(16)})`);
    }
  }

  return connections;
}

/** Monta um controller a partir de um transporte ja aberto, ou devolve null. */
function buildController(
  ctx: DetectionContext,
  transport: LogitechTransport,
  deviceIndex: number,
  idPrefix: string,
  locationLabel: string,
  fallbackName: string,
  serial: string,
): Controller | null {
  const conn = transport.long;
  if (!conn) {
    ctx.log(`Logitech: ${fallbackName} nao expoe a colecao de mensagem longa`);
    return null;
  }

  const identity = getDeviceIdentity(conn, deviceIndex);
  if (!identity) {
    ctx.log(`Logitech: ${fallbackName} nao respondeu a consulta de nome — ignorando`);
    return null;
  }

  // Mesma sanidade do OpenRGB: nome legivel, com tamanho plausivel, e um tipo
  // dentro da tabela conhecida. Lixo aqui significa que respondemos ao device
  // errado, ou que a fila de leitura esta desalinhada.
  const printable = /^[\x20-\x79][\x20-\x7e]*$/.test(identity.name);
  if (!printable || identity.name.length < 4 || identity.logitechType > 8) {
    ctx.log(
      `Logitech: resposta implausivel de ${fallbackName} ` +
        `(nome "${identity.name}", tipo ${identity.logitechType}) — ignorando`,
    );
    return null;
  }

  let featurePage = PAGE_RGB_EFFECTS_8070;
  let rgbFeatureIndex = getFeatureIndex(conn, deviceIndex, PAGE_RGB_EFFECTS_8070);
  if (rgbFeatureIndex === 0) {
    featurePage = PAGE_RGB_EFFECTS_8071;
    rgbFeatureIndex = getFeatureIndex(conn, deviceIndex, PAGE_RGB_EFFECTS_8071);
  }

  if (rgbFeatureIndex === 0) {
    ctx.log(`Logitech: ${identity.name} nao tem pagina de efeitos RGB — ignorando`);
    return null;
  }

  const leds =
    featurePage === PAGE_RGB_EFFECTS_8070
      ? readRgbConfig8070(conn, deviceIndex, rgbFeatureIndex)
      : readRgbConfig8071(conn, deviceIndex, rgbFeatureIndex);

  if (leds.length === 0) {
    ctx.log(`Logitech: ${identity.name} nao reportou nenhum LED — ignorando`);
    return null;
  }

  const { modes, directModeIndex } = buildModes(leds);
  const type = LOGITECH_TYPE_TO_LUMEN[identity.logitechType] ?? 'unknown';
  const version = getProtocolVersion(conn, deviceIndex);

  ctx.log(
    `Logitech: ${identity.name} — ${leds.length} LED(s), ` +
      `${modes.length} modo(s), pagina 0x${featurePage.toString(16)} ` +
      `no indice ${rgbFeatureIndex}`,
  );

  return new LogitechHidppController({
    id: `${idPrefix}:dev${deviceIndex}`,
    name: identity.name,
    type,
    location: locationLabel,
    version,
    serial,
    transport,
    deviceIndex,
    rgbFeatureIndex,
    featurePage,
    leds,
    modes,
    directModeIndex,
  });
}

/** Detector da familia Logitech HID++ com efeitos RGB. */
export const logitechHidppDetector: ControllerDetector = {
  name: 'Logitech HID++',

  detect(ctx: DetectionContext): Controller[] {
    const controllers: Controller[] = [];

    const logitech = ctx.hid.enumerate().filter((d) => d.vendorId === LOGITECH_VID);
    if (logitech.length === 0) return controllers;

    // Agrupa as colecoes por interface fisica: no Windows uma interface vira
    // varias entradas, uma por usage, e precisamos de mais de uma delas.
    const groups = new Map<string, HidDeviceInfo[]>();
    for (const info of logitech) {
      const key = interfaceKey(info);
      const bucket = groups.get(key);
      if (bucket) bucket.push(info);
      else groups.set(key, [info]);
    }

    /* ---------------- Receptores Lightspeed ---------------- */

    for (const spec of RECEIVERS) {
      const group = groups.get(`${spec.pid}:${spec.interfaceNumber}`);
      if (!group) continue;

      // Exigimos as duas colecoes que o protocolo usa. Sem a curta nao da para
      // perguntar quem esta pareado; sem a longa nao da para falar HID++ 2.0.
      const hasShort = group.some((d) => d.usagePage === spec.usagePage && (d.usage ?? 0) === 1);
      const hasLong = group.some((d) => d.usagePage === spec.usagePage && (d.usage ?? 0) === 2);

      if (!hasShort || !hasLong) {
        ctx.log(
          `Logitech: ${spec.label} (PID 0x${spec.pid.toString(16)}) sem as colecoes ` +
            `0xFF00 usage 1 e 2 — ignorando`,
        );
        continue;
      }

      const connections = openUsages(ctx, group);
      if (!connections.has(1) || !connections.has(2)) {
        for (const conn of connections.values()) conn.close();
        ctx.log(`Logitech: ${spec.label} nao abriu as duas colecoes necessarias`);
        continue;
      }

      const receiverPath = group[0]!.path;
      const transport = new LogitechTransport(receiverPath, connections);
      transport.flush();

      const paired = enumeratePairedDevices(transport);
      if (paired.length === 0) {
        ctx.log(`Logitech: ${spec.label} nao tem device pareado conectado`);
        transport.close();
        continue;
      }

      let claimed = 0;

      for (const device of paired) {
        if (!device.online) {
          ctx.log(
            `Logitech: device no indice ${device.deviceIndex} do ${spec.label} ` +
              `esta pareado mas dormindo — ignorando`,
          );
          continue;
        }

        if (claimed > 0) transport.retain();

        const serial = getPairingSerial(transport, device.deviceIndex);
        const controller = buildController(
          ctx,
          transport,
          device.deviceIndex,
          `logitech:${LOGITECH_VID.toString(16)}:${spec.pid.toString(16)}:if${spec.interfaceNumber}`,
          `HID: ${receiverPath} (receptor), indice sem fio ${device.deviceIndex}`,
          `${spec.label} indice ${device.deviceIndex}`,
          serial,
        );

        if (controller) {
          controllers.push(controller);
          claimed++;
        } else if (claimed > 0) {
          // Desfaz o retain que nao virou controller.
          transport.close();
        }
      }

      if (claimed === 0) transport.close();
    }

    /* ---------------- Devices diretos ---------------- */

    for (const spec of DIRECT_DEVICES) {
      const group = groups.get(`${spec.pid}:${spec.interfaceNumber}`);
      if (!group) continue;

      const match = group.find(
        (d) => d.usagePage === spec.usagePage && (d.usage ?? 0) === spec.usage,
      );

      if (!match) {
        ctx.log(
          `Logitech: ${spec.label} sem a colecao 0x${spec.usagePage.toString(16)} ` +
            `usage 0x${spec.usage.toString(16)} — ignorando`,
        );
        continue;
      }

      const connections = openUsages(ctx, [match]);
      if (connections.size === 0) continue;

      const transport = new LogitechTransport(match.path, connections);
      transport.flush();

      const controller = buildController(
        ctx,
        transport,
        DEVICE_INDEX_SELF,
        `logitech:${LOGITECH_VID.toString(16)}:${spec.pid.toString(16)}:if${spec.interfaceNumber}`,
        `HID: ${match.path}`,
        spec.label,
        match.serialNumber ?? '',
      );

      if (controller) controllers.push(controller);
      else transport.close();
    }

    return controllers;
  },
};

/**
 * Motor de efeitos do Lumen.
 *
 * Um unico ticker pinta todos os alvos ativos, o que mantem devices diferentes
 * em fase — e o ponto do produto: um arco-iris que atravessa placa-mae, RAM,
 * GPU e perifericos ao mesmo tempo.
 *
 * Tres cuidados que vieram da medicao em hardware real:
 *
 *  - **SMBus e lento.** A placa-mae e a RAM respondem por I2C/SMBus a alguns
 *    poucos Hz. Mandar 30 fps nelas entope o barramento e trava a deteccao.
 *    Cada alvo tem um teto de fps derivado do transporte.
 *  - **Sem escritas sobrepostas.** Se o write anterior de um device ainda nao
 *    terminou, o frame e descartado em vez de enfileirado. Atrasar luz nao
 *    serve para nada; acumular fila serve menos.
 *  - **Nao reenviar frame identico.** Efeitos estaticos convergem e param de
 *    escrever, em vez de martelar o barramento para sempre.
 */
import type { EffectSpec, RGB, TransportKind } from '../../../shared/types.js';
import { renderTarget } from './kernels.js';

/** Quem realmente escreve no hardware. Mantido abstrato para testabilidade. */
export interface EffectSink {
  writeDevice(backendIndex: number, colors: readonly RGB[]): Promise<void>;
  writeZone(backendIndex: number, zoneIndex: number, colors: readonly RGB[]): Promise<void>;
}

export interface TargetDescriptor {
  /** Chave unica do alvo: `deviceId` ou `deviceId#zoneIndex`. */
  key: string;
  backendIndex: number;
  /** `undefined` pinta o device inteiro. */
  zoneIndex?: number;
  ledCount: number;
  /** Onde o device esta; usado como fallback para inferir o transporte. */
  location: string;
  /** Transporte declarado pelo driver. Preferido sobre adivinhar pela location. */
  transport?: TransportKind;
  /**
   * O firmware grava na flash a cada escrita. Reduz o teto de taxa de forma
   * agressiva — cada frame custa um ciclo de escrita de um orcamento finito.
   */
  writeWearRisk?: boolean;
  /**
   * Posicao deste alvo dentro de uma fita virtual que atravessa TODOS os
   * devices.
   *
   * Sem isso, um efeito espacial trata cada device como uma fita isolada: o
   * arco-iris recomeca do zero na placa-mae, de novo na memoria, de novo no
   * mouse. Cada um tem contagem e layout fisico diferentes, entao o resultado
   * nao parece um efeito so — parece cada device fazendo uma coisa.
   *
   * Com o deslocamento, o LED 0 da memoria continua de onde o ultimo LED da
   * placa parou, e o efeito atravessa a maquina inteira.
   */
  spanOffset?: number;
  /** Total de LEDs da fita virtual. */
  spanTotal?: number;
}

interface ActiveTarget extends TargetDescriptor {
  effect: EffectSpec;
  maxFps: number;
  minFrameMs: number;
  lastFrameAt: number;
  inFlight: boolean;
  buffer: RGB[];
  lastChecksum: number | null;
  consecutiveErrors: number;
}

/**
 * Teto de fps por transporte.
 *
 * Os valores de I2C/SMBus sao conservadores de proposito: o controller
 * Polychrome da placa responde por SMBus a ~0x6A e a RAM Kingston a 0x58/0x59,
 * e esse barramento e compartilhado com o SPD dos modulos de memoria.
 *
 * O casamento por regex sobre a `location` e um fallback, nao a fonte de
 * verdade: a `location` e texto para humanos e muda quando um driver melhora a
 * propria mensagem. Quem souber o transporte deve declara-lo em
 * `TargetDescriptor.transport`. Ja houve um bug exatamente aqui — a placa-mae
 * passou a se identificar como "SMBus PIIX4 1, ..." em vez de "I2C: ...", caiu
 * no padrao generico e rodou a 20 fps em vez de 8.
 */
const FPS_BY_TRANSPORT: ReadonlyArray<{ match: RegExp; fps: number }> = [
  { match: /^(I2C|SMBus)\b|^I2C:/i, fps: 8 },
  { match: /^HID:/i, fps: 30 },
  { match: /^USB:/i, fps: 30 },
  { match: /^serial:/i, fps: 15 },
];

/** Teto por transporte, quando o driver o declara explicitamente. */
const FPS_BY_KIND: Record<TransportKind, number> = {
  smbus: 8,
  'gpu-i2c': 8,
  hid: 30,
  usb: 30,
  serial: 15,
  unknown: 20,
};

const DEFAULT_FPS = 20;

/**
 * Teto para devices cujo firmware grava na flash a cada escrita.
 *
 * 2 fps ainda anima de forma visivel em efeitos lentos (respiracao, ciclo de
 * cores) e reduz o consumo de ciclos de escrita em uma ordem de grandeza
 * frente aos 8 fps do SMBus comum. Nao e uma escolha estetica: e o preco de
 * nao gastar a flash da placa-mae do usuario.
 */
const WEAR_RISK_FPS = 2;

export function fpsForLocation(location: string): number {
  for (const { match, fps } of FPS_BY_TRANSPORT) {
    if (match.test(location)) return fps;
  }
  return DEFAULT_FPS;
}

/** Teto efetivo de um alvo, considerando transporte e desgaste de flash. */
export function fpsForTarget(
  location: string,
  writeWearRisk?: boolean,
  transport?: TransportKind,
): number {
  const byTransport =
    transport !== undefined && transport !== 'unknown'
      ? FPS_BY_KIND[transport]
      : fpsForLocation(location);
  return writeWearRisk === true ? Math.min(byTransport, WEAR_RISK_FPS) : byTransport;
}

/** Checksum barato só para descartar frames identicos. */
function checksum(colors: readonly RGB[]): number {
  let h = 0x811c9dc5;
  for (const c of colors) {
    h = (h ^ c.r) * 0x01000193;
    h = (h ^ c.g) * 0x01000193;
    h = (h ^ c.b) * 0x01000193;
    h >>>= 0;
  }
  return h >>> 0;
}

export class EffectRunner {
  private targets = new Map<string, ActiveTarget>();
  private timer: NodeJS.Timeout | null = null;
  private tickMs: number;

  /**
   * Origem de tempo COMPARTILHADA por todos os alvos.
   *
   * Esta e a razao de o motor existir. Cada alvo tendo a propria origem
   * (`Date.now()` no momento em que entrou) parece inofensivo, mas defasa
   * tudo: aplicar um efeito a cinco devices sao cinco chamadas sequenciais, e
   * uma escrita SMBus leva centenas de milissegundos — entao o ultimo device
   * comecava quase um segundo depois do primeiro, e o arco-iris saia rasgado.
   *
   * Com uma origem unica, todo alvo avalia o kernel no MESMO `t`. Um device
   * que entra depois nao comeca do zero: ele entra na fase em que os outros
   * ja estao, que e exatamente o que "sincronizado" significa.
   */
  private readonly epoch = Date.now();

  constructor(
    private readonly sink: EffectSink,
    /** FPS alvo configurado pelo usuario; funciona como teto global. */
    private globalFpsCap = 30,
    private readonly onError?: (key: string, err: Error) => void,
  ) {
    this.tickMs = Math.max(10, Math.round(1000 / this.globalFpsCap));
  }

  get activeCount(): number {
    return this.targets.size;
  }

  setGlobalFpsCap(fps: number): void {
    this.globalFpsCap = Math.max(1, Math.min(120, fps));
    this.tickMs = Math.max(10, Math.round(1000 / this.globalFpsCap));
    for (const t of this.targets.values()) {
      t.maxFps = Math.min(fpsForTarget(t.location, t.writeWearRisk, t.transport), this.globalFpsCap);
      t.minFrameMs = 1000 / t.maxFps;
    }
    if (this.timer) {
      this.stopTicker();
      this.startTicker();
    }
  }

  /** Ativa (ou substitui) o efeito de um alvo. */
  setEffect(descriptor: TargetDescriptor, effect: EffectSpec): void {
    const maxFps = Math.min(fpsForTarget(descriptor.location, descriptor.writeWearRisk, descriptor.transport), this.globalFpsCap);
    const existing = this.targets.get(descriptor.key);

    this.targets.set(descriptor.key, {
      ...descriptor,
      effect,
      maxFps,
      minFrameMs: 1000 / maxFps,
      lastFrameAt: 0,
      inFlight: false,
      buffer: existing?.buffer ?? [],
      lastChecksum: null,
      consecutiveErrors: 0,
    });

    this.startTicker();
  }

  /** Desativa um alvo. Devolve true se havia algo ativo. */
  clearTarget(key: string): boolean {
    const had = this.targets.delete(key);
    if (this.targets.size === 0) this.stopTicker();
    return had;
  }

  /** Desativa todos os alvos de um device (o device inteiro e suas zonas). */
  clearDevice(deviceId: string): void {
    for (const key of [...this.targets.keys()]) {
      if (key === deviceId || key.startsWith(`${deviceId}#`)) this.targets.delete(key);
    }
    if (this.targets.size === 0) this.stopTicker();
  }

  clearAll(): void {
    this.targets.clear();
    this.stopTicker();
  }

  /**
   * Reconcilia os indices do backend depois de uma redeteccao. Alvos cujo
   * device desapareceu sao removidos.
   */
  remapIndices(resolve: (key: string) => number | undefined): void {
    for (const [key, target] of [...this.targets.entries()]) {
      const next = resolve(key);
      if (next === undefined) this.targets.delete(key);
      else target.backendIndex = next;
    }
    if (this.targets.size === 0) this.stopTicker();
  }

  private startTicker(): void {
    if (this.timer || this.targets.size === 0) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Primeiro frame imediato, para a UI responder na hora.
    this.tick();
  }

  private stopTicker(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();

    for (const target of this.targets.values()) {
      if (target.inFlight) continue;
      if (now - target.lastFrameAt < target.minFrameMs) continue;

      // Origem compartilhada: todos os alvos no mesmo instante do efeito.
      const t = (now - this.epoch) / 1000;

      let colors: RGB[];
      try {
        colors = renderTarget(
          target.effect.kind,
          target.effect.params,
          target.ledCount,
          t,
          target.buffer,
          target.spanTotal !== undefined && target.spanOffset !== undefined
            ? { offset: target.spanOffset, total: target.spanTotal }
            : undefined,
        );
      } catch (err) {
        // Kernel indisponivel: nao ha como recuperar reintentando.
        this.targets.delete(target.key);
        this.onError?.(target.key, err as Error);
        continue;
      }

      const sum = checksum(colors);
      target.lastFrameAt = now;
      if (sum === target.lastChecksum) continue; // frame identico, nao reenvia
      target.lastChecksum = sum;

      target.inFlight = true;
      const write =
        target.zoneIndex === undefined
          ? this.sink.writeDevice(target.backendIndex, colors)
          : this.sink.writeZone(target.backendIndex, target.zoneIndex, colors);

      write
        .then(() => {
          target.inFlight = false;
          target.consecutiveErrors = 0;
        })
        .catch((err: unknown) => {
          target.inFlight = false;
          target.consecutiveErrors++;
          // Um device que falha de forma persistente e desligado, para nao
          // gerar um fluxo infinito de erros no log.
          if (target.consecutiveErrors >= 10) {
            this.targets.delete(target.key);
            if (this.targets.size === 0) this.stopTicker();
            this.onError?.(
              target.key,
              new Error(
                `desativado depois de 10 falhas consecutivas de escrita: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              ),
            );
          }
        });
    }
  }
}

/** Monta a chave canonica de um alvo. */
export function targetKey(deviceId: string, zoneIndex?: number): string {
  return zoneIndex === undefined ? deviceId : `${deviceId}#${zoneIndex}`;
}

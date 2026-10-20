/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Orquestrador do motor do Lumen.
 *
 * O Lumen fala com o hardware por conta propria: PawnIO para SMBus (placa-mae,
 * memoria), NVAPI para a GPU, HID para perifericos. Nao ha servidor externo nem
 * aplicativo de terceiros no caminho — so o driver PawnIO, que e driver, nao
 * aplicativo, e portanto nao disputa o barramento com a gente.
 */
import { EventEmitter } from 'node:events';

import type {
  Assignment,
  Device,
  Diagnostics,
  EngineStatus,
  Profile,
  RGB,
  TargetRef,
} from '../../shared/types.js';
import type { Engine, EngineEvents } from './engine.js';
import { controllerToDevice, findAutonomousModeIndex } from './device-mapper.js';
import { detectControllers } from './detector.js';
import { closeBuses, openBuses, type BusProblem, type BusSet } from './hal/index.js';
import type { Controller } from './hal/types.js';
import { EffectRunner, targetKey, type EffectSink } from './effects/runner.js';
import { isEffectAvailable } from './effects/kernels.js';
import { detectConflictingProcesses, disableAutostart, stopProcessByLabel } from './conflicts.js';

export interface EngineOptions {
  effectFps?: number;
  stopConflictingSoftware?: boolean;
  disableConflictingAutostart?: boolean;
  log?: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
}

const noopLog = {
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};

class LumenEngine extends EventEmitter implements Engine {
  private buses: BusSet | null = null;
  private controllers: Controller[] = [];
  private devices: Device[] = [];
  private runner: EffectRunner;
  private status: EngineStatus = { state: 'starting' };
  private readonly log: NonNullable<EngineOptions['log']>;
  private busProblems: BusProblem[] = [];
  private detectionFailures: Array<{ family: string; error: string }> = [];
  private directControllers = new Set<string>();
  private stopping = false;

  constructor(private readonly opts: EngineOptions) {
    super();
    this.log = opts.log ?? noopLog;

    // As escritas de hardware sao sincronas; o sink as envolve numa Promise
    // para manter o contrato do runner. `setImmediate` devolve o controle ao
    // loop de eventos entre devices, para que uma transacao SMBus lenta nao
    // segure a UI por mais tempo que o necessario.
    const sink: EffectSink = {
      writeDevice: (index, colors) =>
        new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              this.controllerAt(index).updateLeds(colors);
              resolve();
            } catch (err) {
              reject(err as Error);
            }
          });
        }),
      writeZone: (index, zone, colors) =>
        new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              this.controllerAt(index).updateZoneLeds(zone, colors);
              resolve();
            } catch (err) {
              reject(err as Error);
            }
          });
        }),
    };

    this.runner = new EffectRunner(sink, opts.effectFps ?? 30, (key, err) => {
      this.log.warn(`efeito desativado em "${key}": ${err.message}`);
    });
  }

  private controllerAt(index: number): Controller {
    const controller = this.controllers[index];
    if (!controller) throw new Error(`nenhum controller no indice ${index}`);
    return controller;
  }

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.emit('statusChanged', status);
  }

  /* ---------------------------------------------------------------- *
   * Ciclo de vida                                                    *
   * ---------------------------------------------------------------- */

  async start(): Promise<void> {
    this.setStatus({ state: 'starting' });

    // Antes de tocar no barramento: resolver a disputa. SMBus admite um
    // escritor so, e com o software do OEM rodando junto as escritas se
    // intercalam e a iluminacao pisca em cores aleatorias.
    if (this.opts.stopConflictingSoftware) {
      await this.resolveConflicts();
    }

    try {
      this.buses = await openBuses((msg) => this.log.info(msg));
      this.busProblems = this.buses.problems;
      for (const problem of this.busProblems) {
        this.log.warn(`${problem.transport}: ${problem.reason}`);
      }
    } catch (err) {
      this.setStatus({
        state: 'error',
        reason: err instanceof Error ? err.message : String(err),
        hint: 'Nenhum barramento de hardware pode ser aberto.',
      });
      return;
    }

    await this.refreshDevices();

    if (this.devices.length === 0 && this.busProblems.length > 0) {
      const needsElevation = this.busProblems.some((p) => p.needsElevation);
      this.setStatus({
        state: 'error',
        reason: 'Nenhum hardware de iluminacao foi encontrado.',
        hint: needsElevation
          ? 'Reinicie o Lumen como administrador para acessar a placa-mae e a memoria.'
          : this.busProblems[0]?.hint,
      });
      return;
    }

    this.setStatus({ state: 'connected', protocolVersion: 0, serverVersion: 0 });
    void this.emitDiagnostics();
  }

  private async resolveConflicts(): Promise<void> {
    const conflicts = await detectConflictingProcesses();
    for (const label of conflicts) {
      const stopped = await stopProcessByLabel(label);
      this.log.info(
        stopped
          ? `"${label}" encerrado para liberar o barramento`
          : `nao consegui encerrar "${label}" — a iluminacao pode piscar`,
      );
      if (stopped && this.opts.disableConflictingAutostart) {
        if (await disableAutostart(label)) this.log.info(`autostart de "${label}" desativado`);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.runner.clearAll();
    this.handBackToFirmware();

    for (const controller of this.controllers) {
      try {
        controller.close();
      } catch {
        // encerrando mesmo assim
      }
    }
    this.controllers = [];

    if (this.buses) closeBuses(this.buses);
    this.buses = null;
  }

  /**
   * Devolve ao firmware os devices que o Lumen colocou em modo direto.
   *
   * Em modo direto quem pinta e o host. Sair sem isso deixa o device congelado
   * na ultima cor recebida — a luz nao apaga nem continua, so trava numa cor
   * que o usuario nao escolheu.
   */
  private handBackToFirmware(): void {
    for (const controller of this.controllers) {
      if (!this.directControllers.has(controller.id)) continue;

      const modeIndex = findAutonomousModeIndex(controller);
      if (modeIndex === undefined) continue;

      try {
        const mode = controller.modes[modeIndex]!;
        controller.setMode(modeIndex, {
          brightness: mode.brightness?.max,
          colors: mode.colorsMin > 0 ? [{ r: 255, g: 255, b: 255 }] : undefined,
        });
        this.log.info(`"${controller.name}" devolvido ao firmware no modo "${mode.name}"`);
      } catch (err) {
        this.log.warn(
          `nao consegui devolver "${controller.name}" ao firmware: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.directControllers.clear();
  }

  private async refreshDevices(): Promise<void> {
    if (!this.buses || this.stopping) return;

    const result = await detectControllers(this.buses, (msg) => this.log.info(msg));
    this.detectionFailures = result.failures;

    // Fecha os controllers antigos antes de trocar: handles HID vazam senao.
    for (const old of this.controllers) {
      try {
        old.close();
      } catch {
        // segue
      }
    }

    this.controllers = result.controllers;
    this.devices = this.controllers.map((c, i) => controllerToDevice(c, i));

    const indexByKey = new Map<string, number>();
    for (const device of this.devices) {
      indexByKey.set(device.id, device.backendIndex);
      for (const zone of device.zones) {
        indexByKey.set(targetKey(device.id, zone.index), device.backendIndex);
      }
    }
    this.runner.remapIndices((key) => indexByKey.get(key));

    this.emit('devicesChanged', this.devices);
    void this.emitDiagnostics();
  }

  /* ---------------------------------------------------------------- *
   * Consultas                                                        *
   * ---------------------------------------------------------------- */

  getStatus(): EngineStatus {
    return this.status;
  }

  listDevices(): Device[] {
    return this.devices;
  }

  async rescan(): Promise<Device[]> {
    await this.refreshDevices();
    return this.devices;
  }

  async getDiagnostics(): Promise<Diagnostics> {
    const conflicts = await detectConflictingProcesses();

    const failedInterfaces = [
      ...this.busProblems.map((p) => p.reason),
      ...this.detectionFailures.map((f) => `Driver "${f.family}": ${f.error}`),
    ];

    const smbusWorking = (this.buses?.smbus.length ?? 0) > 0;

    return {
      pawnIoInstalled: !this.busProblems.some(
        (p) => p.transport === 'smbus' && /nao esta instalado/i.test(p.reason),
      ),
      backendElevated: smbusWorking,
      conflictingProcesses: conflicts,
      failedInterfaces,
    };
  }

  private async emitDiagnostics(): Promise<void> {
    try {
      this.emit('diagnosticsChanged', await this.getDiagnostics());
    } catch {
      // diagnostico e informativo; falhar nele nao derruba nada
    }
  }

  /* ---------------------------------------------------------------- *
   * Aplicacao                                                        *
   * ---------------------------------------------------------------- */

  private resolve(target: TargetRef): {
    device: Device;
    controller: Controller;
    ledCount: number;
    key: string;
  } {
    const device = this.devices.find((d) => d.id === target.deviceId);
    if (!device) throw new Error(`device desconhecido: ${target.deviceId}`);

    const controller = this.controllerAt(device.backendIndex);

    if (target.zoneIndex === undefined) {
      return { device, controller, ledCount: device.ledCount, key: targetKey(device.id) };
    }

    const zone = device.zones[target.zoneIndex];
    if (!zone) throw new Error(`zona ${target.zoneIndex} nao existe em "${device.name}"`);

    return {
      device,
      controller,
      ledCount: zone.ledsCount,
      key: targetKey(device.id, zone.index),
    };
  }

  async apply(target: TargetRef, assignment: Assignment): Promise<void> {
    const { device, controller, ledCount, key } = this.resolve(target);

    if (assignment.mode === 'lumen') {
      const { effect } = assignment;
      if (!isEffectAvailable(effect.kind)) {
        throw new Error(`o efeito "${effect.kind}" ainda nao esta disponivel neste build`);
      }
      if (device.directModeIndex === undefined) {
        throw new Error(
          `"${device.name}" nao aceita controle direto; use os modos do hardware`,
        );
      }

      // Sem o modo direto, o firmware ignora as escritas por LED.
      controller.setMode(device.directModeIndex, {});
      this.directControllers.add(controller.id);

      if (device.writeWearRisk) {
        this.log.warn(
          `"${device.name}" grava na flash a cada escrita de cor; o efeito roda em taxa ` +
            'reduzida para preservar o controlador. Os modos de firmware nao tem esse custo.',
        );
      }

      this.runner.setEffect(
        {
          key,
          backendIndex: device.backendIndex,
          ...(target.zoneIndex === undefined ? {} : { zoneIndex: target.zoneIndex }),
          ledCount,
          location: device.location,
          transport: device.transport,
          writeWearRisk: device.writeWearRisk,
        },
        effect,
      );
      return;
    }

    /* ---- modo de firmware ---- */

    // Um modo de firmware vale para o device inteiro, entao qualquer efeito do
    // Lumen nele precisa sair de cena. E, com o firmware no comando, o device
    // deixa de depender da gente.
    this.runner.clearDevice(device.id);
    this.directControllers.delete(controller.id);

    const mode = device.modes[assignment.modeIndex];
    if (!mode) throw new Error(`modo ${assignment.modeIndex} nao existe em "${device.name}"`);

    controller.setMode(assignment.modeIndex, {
      colors: assignment.colors.length > 0 ? assignment.colors : undefined,
      speed: mode.speed && assignment.speed !== undefined
        ? clampTo(assignment.speed, mode.speed.min, mode.speed.max)
        : undefined,
      brightness: mode.brightness && assignment.brightness !== undefined
        ? clampTo(assignment.brightness, mode.brightness.min, mode.brightness.max)
        : undefined,
      direction: assignment.direction,
    });

    // Modos que pintam por LED ainda precisam receber as cores.
    if (mode.supportsPerLed && assignment.colors.length > 0) {
      const fill = assignment.colors[0]!;
      const colors: RGB[] = Array.from({ length: ledCount }, () => ({ ...fill }));
      if (target.zoneIndex === undefined) controller.updateLeds(colors);
      else controller.updateZoneLeds(target.zoneIndex, colors);
    }
  }

  async applyAll(assignment: Assignment): Promise<void> {
    const results = await Promise.allSettled(
      this.devices.map((d) => this.apply({ deviceId: d.id }, assignment)),
    );

    const failed = results
      .map((r, i) => (r.status === 'rejected' ? (this.devices[i]?.name ?? '?') : null))
      .filter((n): n is string => n !== null);

    if (failed.length === this.devices.length && this.devices.length > 0) {
      throw new Error(`nenhum device aceitou o comando (${failed.join(', ')})`);
    }
    if (failed.length > 0) this.log.warn(`aplicado parcialmente; falhou em: ${failed.join(', ')}`);
  }

  async resizeZone(deviceId: string, zoneIndex: number, ledsCount: number): Promise<void> {
    const device = this.devices.find((d) => d.id === deviceId);
    if (!device) throw new Error(`device desconhecido: ${deviceId}`);

    const zone = device.zones[zoneIndex];
    if (!zone) throw new Error(`zona ${zoneIndex} nao existe em "${device.name}"`);
    if (!zone.resizable) throw new Error(`a zona "${zone.name}" tem tamanho fixo`);

    const controller = this.controllerAt(device.backendIndex);
    if (!controller.resizeZone) {
      throw new Error(`"${device.name}" nao suporta redimensionar zonas`);
    }

    controller.resizeZone(zoneIndex, clampTo(ledsCount, zone.ledsMin, zone.ledsMax));
    await this.refreshDevices();
  }

  async applyProfile(profile: Profile): Promise<void> {
    const failures: string[] = [];
    // Sequencial de proposito: em paralelo, varios modos de firmware
    // disputariam o mesmo device.
    for (const entry of profile.entries) {
      try {
        await this.apply(entry.target, entry.assignment);
      } catch (err) {
        failures.push(
          `${entry.target.deviceId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (failures.length > 0) {
      this.log.warn(`perfil "${profile.name}" aplicado com falhas: ${failures.join('; ')}`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Eventos                                                          *
   * ---------------------------------------------------------------- */

  override on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): () => void;
  override on(event: string, listener: (...args: never[]) => void): this;
  override on(event: string, listener: (...args: never[]) => void): (() => void) | this {
    super.on(event, listener as (...args: unknown[]) => void);
    return () => {
      super.off(event, listener as (...args: unknown[]) => void);
    };
  }
}

function clampTo(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/** Ponto de entrada usado pelo processo principal do Electron. */
export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  return new LumenEngine(options);
}

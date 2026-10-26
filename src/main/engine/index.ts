/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Motor do Lumen — fachada no processo principal.
 *
 * O trabalho de verdade acontece num worker thread (`worker/hal-worker.ts`),
 * que possui os barramentos, os drivers e o motor de efeitos. Este arquivo so
 * traduz chamadas em mensagens.
 *
 * A separacao nao e enfeite arquitetural: falar com RGB e sincrono e lento.
 * Medido nesta maquina, pintar um quadro em todos os devices custa ~318ms —
 * e, na thread principal, esse e o tempo em que a janela nao responde a nada.
 * O sintoma relatado foi exatamente esse, "o app fica travando".
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type {
  Assignment,
  Device,
  Diagnostics,
  EngineStatus,
  Profile,
  TargetRef,
} from '../../shared/types.js';
import type { Engine, EngineEvents } from './engine.js';
import { pawnIoModuleDir } from './hal/index.js';
import type { ApplyManyResult, WorkerCommand, WorkerEvent, WorkerRequest } from './worker/protocol.js';

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

/** Tempo maximo que uma operacao de hardware pode levar antes de desistirmos. */
const COMMAND_TIMEOUT_MS = 60_000;

class LumenEngine extends EventEmitter implements Engine {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();

  private devices: Device[] = [];
  private status: EngineStatus = { state: 'starting' };
  private readonly log: NonNullable<EngineOptions['log']>;

  constructor(private readonly opts: EngineOptions) {
    super();
    this.log = opts.log ?? noopLog;
  }

  /* ---------------------------------------------------------------- *
   * Worker                                                           *
   * ---------------------------------------------------------------- */

  private spawnWorker(): Worker {
    // O worker e empacotado como entrada propria pelo electron-vite, ao lado
    // do bundle do processo principal.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const workerPath = path.join(here, 'hal-worker.mjs');

    const worker = new Worker(workerPath, {
      workerData: { pawnIoModuleDir: pawnIoModuleDir() },
    });

    worker.on('message', (event: WorkerEvent) => this.onWorkerEvent(event));

    worker.on('error', (err: Error) => {
      this.log.error(`worker de hardware falhou: ${err.message}`);
      this.failAllPending(err);
      this.setStatus({
        state: 'error',
        reason: `O componente que fala com o hardware falhou: ${err.message}`,
        hint: 'Reinicie o Lumen. Se persistir, veja os logs em %APPDATA%/lumen/logs.',
      });
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        this.log.error(`worker de hardware encerrou com codigo ${code}`);
        this.failAllPending(new Error(`worker encerrou (codigo ${code})`));
      }
      this.worker = null;
    });

    return worker;
  }

  private onWorkerEvent(event: WorkerEvent): void {
    switch (event.kind) {
      case 'result': {
        const entry = this.pending.get(event.id);
        if (!entry) return;
        this.pending.delete(event.id);
        clearTimeout(entry.timer);
        if (event.ok) entry.resolve(event.value);
        else entry.reject(new Error(event.error));
        return;
      }

      case 'devicesChanged':
        this.devices = event.devices;
        this.emit('devicesChanged', this.devices);
        return;

      case 'diagnosticsChanged':
        this.emit('diagnosticsChanged', event.diagnostics);
        return;

      case 'log':
        this.log[event.level](event.message);
        return;
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private send<T>(command: WorkerRequest): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('o motor nao esta em execucao'));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`a operacao "${command.kind}" nao respondeu a tempo`));
      }, COMMAND_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      worker.postMessage({ ...command, id } as WorkerCommand);
    });
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

    try {
      this.worker = this.spawnWorker();
    } catch (err) {
      this.setStatus({
        state: 'error',
        reason: `nao consegui iniciar o componente de hardware: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }

    try {
      const result = await this.send<{ devices: Device[]; problems: Array<{ needsElevation?: boolean; reason: string; hint?: string }> }>({
        kind: 'start',
        options: {
          effectFps: this.opts.effectFps,
          stopConflictingSoftware: this.opts.stopConflictingSoftware,
          disableConflictingAutostart: this.opts.disableConflictingAutostart,
        },
      });

      this.devices = result.devices;

      // Zero devices NAO e falha do servico.
      //
      // Antes isso virava `state: 'error'`, e a UI renderiza estado de erro
      // como "o Lumen perdeu contato com o servico de iluminacao". Mentira: o
      // worker subiu, respondeu, e disse honestamente que nao achou nada. O
      // usuario via o app se declarar quebrado em cima do aviso que explicava
      // o problema de verdade — dois diagnosticos concorrentes para um fato.
      //
      // Quem encontrou nada ja tem quem conte: o `DiagnosticsBanner` aponta a
      // causa (driver, privilegio ou barramento) e a tela vazia explica o
      // resto. O servico esta conectado; e so a casa que esta vazia.
      if (this.devices.length === 0 && result.problems.length > 0) {
        for (const problem of result.problems) {
          this.log.info(`nenhum device encontrado: ${problem.reason}`);
        }
      }

      this.setStatus({ state: 'connected', protocolVersion: 0, serverVersion: 0 });
    } catch (err) {
      this.setStatus({
        state: 'error',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.worker) return;

    try {
      await this.send({ kind: 'stop' });
    } catch (err) {
      this.log.warn(`falha ao encerrar o worker: ${err instanceof Error ? err.message : err}`);
    }

    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
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
    this.devices = await this.send<Device[]>({ kind: 'rescan' });
    return this.devices;
  }

  getDiagnostics(): Promise<Diagnostics> {
    return this.send<Diagnostics>({ kind: 'getDiagnostics' });
  }

  /* ---------------------------------------------------------------- *
   * Aplicacao                                                        *
   * ---------------------------------------------------------------- */

  async apply(target: TargetRef, assignment: Assignment): Promise<void> {
    await this.send({ kind: 'apply', target, assignment });
  }

  async applyAll(assignment: Assignment): Promise<void> {
    const result = await this.send<ApplyManyResult>({ kind: 'applyAll', assignment });
    this.reportBatch(result);
  }

  /** Aplica a um subconjunto, numa unica ida ao worker. */
  async applyMany(deviceIds: readonly string[], assignment: Assignment): Promise<ApplyManyResult> {
    const result = await this.send<ApplyManyResult>({
      kind: 'applyMany',
      deviceIds,
      assignment,
    });
    this.reportBatch(result);
    return result;
  }

  private reportBatch(result: ApplyManyResult): void {
    if (result.failed.length === 0) return;

    const names = result.failed
      .map((f) => this.devices.find((d) => d.id === f.deviceId)?.name ?? f.deviceId)
      .join(', ');

    if (result.applied.length === 0) {
      throw new Error(`nenhum device aceitou o comando (${names})`);
    }
    this.log.warn(`aplicado parcialmente; falhou em: ${names}`);
  }

  async resizeZone(deviceId: string, zoneIndex: number, ledsCount: number): Promise<void> {
    this.devices = await this.send<Device[]>({
      kind: 'resizeZone',
      deviceId,
      zoneIndex,
      ledsCount,
    });
  }

  async applyProfile(profile: Profile): Promise<void> {
    const failures: string[] = [];
    // Sequencial: em paralelo, varios modos de firmware disputariam o mesmo
    // device. O worker ja serializa o barramento, mas a ordem importa.
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

/** Ponto de entrada usado pelo processo principal do Electron. */
export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  return new LumenEngine(options);
}

/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Worker de hardware.
 *
 * Tudo que toca o barramento mora aqui: PawnIO/SMBus, NVAPI, HID, os drivers e
 * o motor de efeitos. A thread principal nunca bloqueia por causa de uma
 * escrita RGB.
 *
 * A medicao que motivou isto: pintar um quadro em todos os devices custava
 * 318ms (e 734ms antes das correcoes de temporizacao). Na thread principal,
 * isso e tempo em que a janela nao responde a nada.
 */
import { parentPort, workerData } from 'node:worker_threads';

import {
  COLOR_MODE,
  type Assignment,
  type Device,
  type Diagnostics,
  type RGB,
  type TargetRef,
} from '../../../shared/types.js';
import { controllerToDevice, findAutonomousModeIndex } from '../device-mapper.js';
import { detectControllers } from '../detector.js';
import { closeBuses, openBuses, type BusProblem, type BusSet } from '../hal/index.js';
import type { Controller } from '../hal/types.js';
import { EffectRunner, targetKey, type EffectSink } from '../effects/runner.js';
import { isEffectAvailable } from '../effects/kernels.js';
import { detectConflictingProcesses, disableAutostart, stopProcessByLabel } from '../conflicts.js';
import { isPawnIoInstalled } from '../hal/pawnio.js';
import { isElevated } from '../../privilege.js';
import type { ApplyManyResult, WorkerCommand, WorkerEvent, WorkerStartOptions } from './protocol.js';

if (!parentPort) {
  throw new Error('hal-worker precisa ser carregado como worker thread');
}
const port = parentPort;

function post(event: WorkerEvent): void {
  port.postMessage(event);
}

const log = {
  info: (message: string): void => post({ kind: 'log', level: 'info', message }),
  warn: (message: string): void => post({ kind: 'log', level: 'warn', message }),
  error: (message: string): void => post({ kind: 'log', level: 'error', message }),
};

/* ------------------------------------------------------------------ *
 * Estado                                                             *
 * ------------------------------------------------------------------ */

let buses: BusSet | null = null;
let controllers: Controller[] = [];
let devices: Device[] = [];
let busProblems: BusProblem[] = [];
let detectionFailures: Array<{ family: string; error: string }> = [];
const directControllers = new Set<string>();
let options: WorkerStartOptions = {};

function controllerAt(index: number): Controller {
  const controller = controllers[index];
  if (!controller) throw new Error(`nenhum controller no indice ${index}`);
  return controller;
}

/**
 * As escritas sao sincronas, mas aqui isso nao bloqueia ninguem alem deste
 * worker — que e exatamente o ponto.
 */
const sink: EffectSink = {
  writeDevice: (index, colors) => {
    controllerAt(index).updateLeds(colors);
    return Promise.resolve();
  },
  writeZone: (index, zone, colors) => {
    controllerAt(index).updateZoneLeds(zone, colors);
    return Promise.resolve();
  },
};

const runner = new EffectRunner(sink, 30, (key, err) => {
  log.warn(`efeito desativado em "${key}": ${err.message}`);
});

/* ------------------------------------------------------------------ *
 * Ciclo de vida                                                      *
 * ------------------------------------------------------------------ */

async function start(opts: WorkerStartOptions): Promise<void> {
  options = opts;
  runner.setGlobalFpsCap(opts.effectFps ?? 30);

  // Antes de tocar no barramento: resolver a disputa. SMBus admite um
  // escritor so, e com o software do OEM rodando junto as escritas se
  // intercalam e a iluminacao pisca de forma erratica.
  if (opts.stopConflictingSoftware) {
    for (const label of await detectConflictingProcesses()) {
      const stopped = await stopProcessByLabel(label);
      log.info(
        stopped
          ? `"${label}" encerrado para liberar o barramento`
          : `nao consegui encerrar "${label}" — a iluminacao pode piscar`,
      );
      if (stopped && opts.disableConflictingAutostart) {
        if (await disableAutostart(label)) log.info(`autostart de "${label}" desativado`);
      }
    }
  }

  buses = await openBuses((msg) => log.info(msg));
  busProblems = buses.problems;
  for (const problem of busProblems) log.warn(`${problem.transport}: ${problem.reason}`);

  await refreshDevices();
}

async function stop(): Promise<void> {
  runner.clearAll();
  handBackToFirmware();

  for (const controller of controllers) {
    try {
      controller.close();
    } catch {
      // encerrando mesmo assim
    }
  }
  controllers = [];

  if (buses) closeBuses(buses);
  buses = null;
}

/**
 * Devolve ao firmware os devices que o Lumen colocou em modo direto.
 *
 * Em modo direto quem pinta e o host. Sair sem isso deixa o device congelado
 * na ultima cor recebida.
 */
function handBackToFirmware(): void {
  for (const controller of controllers) {
    if (!directControllers.has(controller.id)) continue;

    const modeIndex = findAutonomousModeIndex(controller);
    if (modeIndex === undefined) continue;

    try {
      const mode = controller.modes[modeIndex]!;
      controller.setMode(modeIndex, {
        brightness: mode.brightness?.max,
        colors: mode.colorsMin > 0 ? [{ r: 255, g: 255, b: 255 }] : undefined,
      });
      log.info(`"${controller.name}" devolvido ao firmware no modo "${mode.name}"`);
    } catch (err) {
      log.warn(
        `nao consegui devolver "${controller.name}" ao firmware: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  directControllers.clear();
}

async function refreshDevices(): Promise<void> {
  if (!buses) return;

  const result = await detectControllers(buses, (msg) => log.info(msg));
  detectionFailures = result.failures;

  for (const old of controllers) {
    try {
      old.close();
    } catch {
      // segue
    }
  }

  controllers = result.controllers;
  devices = controllers.map((c, i) => controllerToDevice(c, i));

  const indexByKey = new Map<string, number>();
  for (const device of devices) {
    indexByKey.set(device.id, device.backendIndex);
    for (const zone of device.zones) {
      indexByKey.set(targetKey(device.id, zone.index), device.backendIndex);
    }
  }
  runner.remapIndices((key) => indexByKey.get(key));

  post({ kind: 'devicesChanged', devices });
  post({ kind: 'diagnosticsChanged', diagnostics: await getDiagnostics() });
}

async function getDiagnostics(): Promise<Diagnostics> {
  const conflicts = await detectConflictingProcesses();
  return {
    pawnIoInstalled: isPawnIoInstalled(),
    // Privilegio REAL do processo, nao "o SMBus abriu".
    //
    // Deduzir elevacao de "o barramento abriu" junta duas perguntas
    // diferentes e produz conselho errado: num PC sem o driver PawnIO o SMBus
    // nao abre, o diagnostico dizia "sem privilegio", e a interface pedia para
    // reiniciar como administrador. O usuario reiniciava, o driver continuava
    // faltando, e a mensagem nao mudava.
    backendElevated: isElevated(),
    smbusAvailable: (buses?.smbus.length ?? 0) > 0,
    conflictingProcesses: conflicts,
    // Somente falhas de DRIVER.
    //
    // Os problemas de barramento (driver ausente, falta de privilegio) ja sao
    // o aviso principal; repeti-los aqui mostrava o mesmo problema duas vezes,
    // e a segunda numa frase montada por concatenacao que nem se lia direito:
    // "Na ultima varredura, O Lumen precisa de privilegio... nao respondeu."
    failedInterfaces: detectionFailures.map((f) => `${f.family} (${f.error})`),
  };
}

/* ------------------------------------------------------------------ *
 * Aplicacao                                                          *
 * ------------------------------------------------------------------ */

function resolve(target: TargetRef): {
  device: Device;
  controller: Controller;
  ledCount: number;
  key: string;
} {
  const device = devices.find((d) => d.id === target.deviceId);
  if (!device) throw new Error(`device desconhecido: ${target.deviceId}`);

  const controller = controllerAt(device.backendIndex);

  if (target.zoneIndex === undefined) {
    return { device, controller, ledCount: device.ledCount, key: targetKey(device.id) };
  }

  const zone = device.zones[target.zoneIndex];
  if (!zone) throw new Error(`zona ${target.zoneIndex} nao existe em "${device.name}"`);

  return { device, controller, ledCount: zone.ledsCount, key: targetKey(device.id, zone.index) };
}

/**
 * Fita virtual: posicao de cada device numa sequencia unica de LEDs.
 *
 * Preenchida quando um efeito e aplicado a varios devices de uma vez. Efeitos
 * espaciais usam isso para atravessar a maquina em vez de reiniciar em cada
 * device.
 */
let span: { offsets: Map<string, number>; total: number } | null = null;

/** Monta a fita virtual na ordem dada, do primeiro device ao ultimo. */
function buildSpan(deviceIds: readonly string[]): void {
  const offsets = new Map<string, number>();
  let total = 0;

  for (const id of deviceIds) {
    const device = devices.find((d) => d.id === id);
    if (!device) continue;
    offsets.set(id, total);
    total += device.ledCount;
  }

  span = total > 0 ? { offsets, total } : null;
}

function apply(target: TargetRef, assignment: Assignment): void {
  const { device, controller, ledCount, key } = resolve(target);

  if (assignment.mode === 'lumen') {
    const { effect } = assignment;
    if (!isEffectAvailable(effect.kind)) {
      throw new Error(`o efeito "${effect.kind}" ainda nao esta disponivel neste build`);
    }
    if (device.directModeIndex === undefined) {
      throw new Error(`"${device.name}" nao aceita controle direto; use os modos do hardware`);
    }

    controller.setMode(device.directModeIndex, {});
    directControllers.add(controller.id);

    // Quando o alvo faz parte de uma fita virtual, o efeito espacial enxerga
    // a posicao global do LED — e o arco-iris atravessa os devices em vez de
    // recomecar em cada um.
    const spanOffset = target.zoneIndex === undefined ? span?.offsets.get(device.id) : undefined;

    runner.setEffect(
      {
        key,
        backendIndex: device.backendIndex,
        ...(target.zoneIndex === undefined ? {} : { zoneIndex: target.zoneIndex }),
        ledCount,
        location: device.location,
        transport: device.transport,
        writeWearRisk: device.writeWearRisk,
        ...(spanOffset !== undefined && span
          ? { spanOffset, spanTotal: span.total }
          : {}),
      },
      effect,
    );
    return;
  }

  // Um modo de firmware vale para o device inteiro.
  runner.clearDevice(device.id);
  directControllers.delete(controller.id);

  const mode = device.modes[assignment.modeIndex];
  if (!mode) throw new Error(`modo ${assignment.modeIndex} nao existe em "${device.name}"`);

  controller.setMode(assignment.modeIndex, {
    colors: assignment.colors.length > 0 ? assignment.colors : undefined,
    speed:
      mode.speed && assignment.speed !== undefined
        ? clampTo(assignment.speed, mode.speed.min, mode.speed.max)
        : undefined,
    brightness:
      mode.brightness && assignment.brightness !== undefined
        ? clampTo(assignment.brightness, mode.brightness.min, mode.brightness.max)
        : undefined,
    direction: assignment.direction,
  });

  if (mode.supportsPerLed && assignment.colors.length > 0) {
    const fill = assignment.colors[0]!;
    const colors: RGB[] = Array.from({ length: ledCount }, () => ({ ...fill }));
    if (target.zoneIndex === undefined) controller.updateLeds(colors);
    else controller.updateZoneLeds(target.zoneIndex, colors);
  }

  if (mode.colorMode === COLOR_MODE.NONE) {
    // Modos que geram as proprias cores nao precisam de mais nada.
  }
}

/**
 * Aplica a varios devices numa chamada so.
 *
 * Sequencial de proposito — o barramento nao tolera escritas concorrentes — e
 * continua apos falha, porque um device problematico nao pode impedir os
 * outros de receberem o efeito.
 */
function applyMany(deviceIds: readonly string[], assignment: Assignment): ApplyManyResult {
  const applied: string[] = [];
  const failed: Array<{ deviceId: string; error: string }> = [];

  // Monta a fita virtual ANTES de aplicar: cada device precisa conhecer a
  // propria posicao no conjunto para que um efeito espacial atravesse todos.
  if (assignment.mode === 'lumen') buildSpan(deviceIds);

  for (const deviceId of deviceIds) {
    try {
      apply({ deviceId }, assignment);
      applied.push(deviceId);
    } catch (err) {
      failed.push({ deviceId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { applied, failed };
}

function clampTo(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/* ------------------------------------------------------------------ *
 * Despacho                                                           *
 * ------------------------------------------------------------------ */

async function handle(command: WorkerCommand): Promise<unknown> {
  switch (command.kind) {
    case 'start':
      await start(command.options);
      return { devices, problems: busProblems };

    case 'stop':
      await stop();
      return null;

    case 'rescan':
      await refreshDevices();
      return devices;

    case 'listDevices':
      return devices;

    case 'getDiagnostics':
      return getDiagnostics();

    case 'apply':
      // Aplicacao a um device so: ele e a propria fita, sem deslocamento.
      span = null;
      apply(command.target, command.assignment);
      return null;

    case 'applyAll':
      return applyMany(
        devices.map((d) => d.id),
        command.assignment,
      );

    case 'applyMany':
      return applyMany(command.deviceIds, command.assignment);

    case 'resizeZone': {
      const device = devices.find((d) => d.id === command.deviceId);
      if (!device) throw new Error(`device desconhecido: ${command.deviceId}`);

      const zone = device.zones[command.zoneIndex];
      if (!zone) throw new Error(`zona ${command.zoneIndex} nao existe em "${device.name}"`);
      if (!zone.resizable) throw new Error(`a zona "${zone.name}" tem tamanho fixo`);

      const controller = controllerAt(device.backendIndex);
      if (!controller.resizeZone) {
        throw new Error(`"${device.name}" nao suporta redimensionar zonas`);
      }

      controller.resizeZone(command.zoneIndex, clampTo(command.ledsCount, zone.ledsMin, zone.ledsMax));
      await refreshDevices();
      return devices;
    }

    case 'setEffectFps':
      runner.setGlobalFpsCap(command.fps);
      options = { ...options, effectFps: command.fps };
      return null;
  }
}

port.on('message', (command: WorkerCommand) => {
  void (async () => {
    try {
      const value = await handle(command);
      post({ kind: 'result', id: command.id, ok: true, value });
    } catch (err) {
      post({
        kind: 'result',
        id: command.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

// O processo principal pode passar o caminho dos modulos do PawnIO: so ele
// conhece `process.resourcesPath` de forma confiavel.
if (workerData && typeof workerData === 'object' && 'pawnIoModuleDir' in workerData) {
  const dir = (workerData as { pawnIoModuleDir?: string }).pawnIoModuleDir;
  if (dir) process.env['LUMEN_PAWNIO_DIR'] = dir;
}

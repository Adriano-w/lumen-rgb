/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Abertura dos barramentos de hardware.
 *
 * Regra central: **nenhuma falha aqui pode derrubar a inicializacao**. Cada
 * transporte e opcional e degrada sozinho — sem PawnIO perde-se placa-mae e
 * memoria, sem NVIDIA perde-se a GPU, mas os perifericos USB continuam
 * funcionando. Um app de RGB que nao abre porque faltou um driver e pior que
 * um que abre mostrando o que consegue e explicando o resto.
 */
import path from 'node:path';
import fs from 'node:fs';

import { PawnIoSmbus } from './smbus.js';
import { PawnIoUnavailableError, isPawnIoInstalled, getPawnIoVersion } from './pawnio.js';
import type { HidBus, I2cBus, SmbusBus } from './types.js';

export interface BusSet {
  smbus: SmbusBus[];
  hid: HidBus | null;
  gpu: I2cBus[];
  /** O que nao abriu e por que — alimenta o diagnostico da UI. */
  problems: BusProblem[];
}

export interface BusProblem {
  transport: 'smbus' | 'hid' | 'gpu';
  reason: string;
  /** O que o usuario pode fazer a respeito. */
  hint?: string;
  /** Resolve com elevacao. */
  needsElevation?: boolean;
}

/**
 * Electron, quando houver.
 *
 * A HAL tambem roda fora do Electron — os scripts de validacao em
 * `scripts/` a usam direto do Node. Um `import` estatico de 'electron'
 * quebraria ali, entao a dependencia e opcional e resolvida em tempo de
 * execucao.
 */
function electronApp(): { isPackaged?: boolean; getAppPath?: () => string } | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('electron') as { app?: never }).app ?? null;
  } catch {
    return null;
  }
}

/** Onde moram os modulos `.bin` do PawnIO, em dev, empacotado e em script. */
export function pawnIoModuleDir(): string {
  const app = electronApp();

  // `resourcesPath` so existe sob Electron; fora dele o campo nem aparece.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  const candidates = app?.isPackaged && resourcesPath
    ? [path.join(resourcesPath, 'pawnio')]
    : [
        path.join(process.cwd(), 'resources', 'pawnio'),
        ...(app?.getAppPath ? [path.join(app.getAppPath(), 'resources', 'pawnio')] : []),
      ];

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'SmbusPIIX4.bin'))) return dir;
    } catch {
      // tenta o proximo
    }
  }
  return candidates[0]!;
}

export async function openBuses(log: (msg: string) => void): Promise<BusSet> {
  const problems: BusProblem[] = [];

  const smbus = openSmbus(log, problems);
  const hid = await openHid(log, problems);
  const gpu = await openGpu(log, problems);

  return { smbus, hid, gpu, problems };
}

/* ------------------------------------------------------------------ *
 * SMBus                                                              *
 * ------------------------------------------------------------------ */

function openSmbus(log: (msg: string) => void, problems: BusProblem[]): SmbusBus[] {
  if (!isPawnIoInstalled()) {
    problems.push({
      transport: 'smbus',
      reason: 'O driver PawnIO nao esta instalado.',
      hint: 'Instale de https://pawnio.eu para controlar a placa-mae e a memoria.',
    });
    return [];
  }

  try {
    // Hoje so o caminho AMD (PIIX4) esta implementado — e o chipset desta
    // maquina. Intel usa SmbusI801.bin, com a mesma interface de modulo.
    const buses = PawnIoSmbus.openPiix4(pawnIoModuleDir());
    log(`SMBus pronto via PawnIO v${getPawnIoVersion() ?? '?'}: ${buses.length} barramento(s)`);
    return buses;
  } catch (err) {
    if (err instanceof PawnIoUnavailableError) {
      problems.push({
        transport: 'smbus',
        reason:
          err.reason === 'not-elevated'
            ? 'O Lumen precisa de privilegio de administrador para acessar a placa-mae e a memoria.'
            : err.message,
        hint:
          err.reason === 'not-elevated'
            ? 'Reinicie o Lumen como administrador.'
            : 'Verifique se o servico PawnIO esta rodando.',
        needsElevation: err.reason === 'not-elevated',
      });
    } else {
      problems.push({
        transport: 'smbus',
        reason: `SMBus indisponivel: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * HID                                                                *
 * ------------------------------------------------------------------ */

async function openHid(log: (msg: string) => void, problems: BusProblem[]): Promise<HidBus | null> {
  try {
    const { NodeHidBus } = await import('./hid.js');
    const bus = new NodeHidBus();
    const count = bus.enumerate().length;
    log(`HID pronto: ${count} device(s) no sistema`);
    return bus;
  } catch (err) {
    problems.push({
      transport: 'hid',
      reason: `USB/HID indisponivel: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'Perifericos USB (mouse, teclado, headset) nao serao detectados.',
    });
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * GPU                                                                *
 * ------------------------------------------------------------------ */

async function openGpu(log: (msg: string) => void, problems: BusProblem[]): Promise<I2cBus[]> {
  try {
    const { detectNvapiI2cBuses, nvapiLoadError } = await import('./nvapi.js');
    const buses = detectNvapiI2cBuses(log);

    if (buses.length === 0) {
      // Sem GPU NVIDIA isto e o caso normal, nao um defeito.
      const reason = nvapiLoadError();
      if (reason) {
        problems.push({
          transport: 'gpu',
          reason: `I2C de GPU indisponivel: ${reason}`,
          hint: 'A iluminacao da placa de video nao sera detectada.',
        });
      }
      return [];
    }

    log(`I2C de GPU pronto: ${buses.length} barramento(s) NVIDIA`);
    return buses;
  } catch (err) {
    // Sem GPU NVIDIA isto e o caso normal, nao um defeito — por isso entra
    // como problema informativo e nao como erro.
    problems.push({
      transport: 'gpu',
      reason: `I2C de GPU indisponivel: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'A iluminacao da placa de video nao sera detectada.',
    });
    return [];
  }
}

export function closeBuses(buses: BusSet): void {
  for (const bus of buses.smbus) {
    const closable = bus as { close?: () => void };
    closable.close?.();
  }
}

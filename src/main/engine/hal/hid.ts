/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 *
 * Transporte HID generico. Nao ha protocolo de iluminacao aqui — este arquivo
 * nao deriva do OpenRGB, so embrulha o pacote `node-hid` no contrato `HidBus`.
 */

/**
 * Barramento HID sobre o pacote `node-hid`.
 *
 * Duas decisoes valem explicacao:
 *
 *  1. **Carga por `createRequire`.** O `node-hid` e um modulo nativo CommonJS e
 *     o Lumen e ESM. Um `import` estatico amarraria o grafo de modulos do
 *     processo principal a um binario que pode simplesmente nao carregar
 *     (prebuilt ausente para a ABI do Electron, DLL faltando, antivirus). Com
 *     `createRequire` a carga e tardia e o erro fica contido aqui.
 *
 *  2. **Degradar, nao morrer.** Se o binario nao carregar, `enumerate()`
 *     devolve lista vazia e a deteccao segue com SMBus e GPU. Perder os
 *     perifericos USB e ruim; nao abrir o app e pior.
 */
import { createRequire } from 'node:module';

import type { HidBus, HidConnection, HidDeviceInfo } from './types.js';

type NodeHidModule = typeof import('node-hid');

export class HidUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HidUnavailableError';
  }
}

/* ------------------------------------------------------------------ *
 * Carga tardia do binario nativo                                     *
 * ------------------------------------------------------------------ */

let cachedModule: NodeHidModule | null = null;
/** Guardamos a falha para nao repetir um `require` que ja sabemos que quebra. */
let loadFailure: unknown = null;

function loadNodeHid(): NodeHidModule | null {
  if (cachedModule) return cachedModule;
  if (loadFailure !== null) return null;

  try {
    const require = createRequire(import.meta.url);
    cachedModule = require('node-hid') as NodeHidModule;
    return cachedModule;
  } catch (err) {
    loadFailure = err;
    return null;
  }
}

/** True quando o binario nativo carregou. Util para o diagnostico da UI. */
export function isHidAvailable(): boolean {
  return loadNodeHid() !== null;
}

/** Motivo da falha de carga, ja formatado. `null` quando carregou. */
export function hidLoadError(): string | null {
  if (loadNodeHid() !== null) return null;
  return loadFailure instanceof Error ? loadFailure.message : String(loadFailure);
}

/** Versao do hidapi embutido, quando disponivel. */
export function hidapiVersion(): string | null {
  const hid = loadNodeHid();
  if (!hid) return null;
  try {
    return hid.getHidapiVersion();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Conexao                                                            *
 * ------------------------------------------------------------------ */

/** Instancia aberta do `node-hid`, no minimo que o contrato exige. */
interface NativeHid {
  write(values: number[]): number;
  sendFeatureReport(data: number[]): number;
  getFeatureReport(reportId: number, reportLength: number): number[];
  readTimeout(timeout: number): number[];
  close(): void;
}

class NodeHidConnection implements HidConnection {
  private closed = false;

  constructor(
    private readonly device: NativeHid,
    private readonly path: string,
  ) {}

  private assertOpen(): void {
    if (this.closed) {
      throw new HidUnavailableError(`conexao HID ja fechada: ${this.path}`);
    }
  }

  write(data: readonly number[]): number {
    this.assertOpen();
    // `node-hid` muta/consome o array; mandamos sempre uma copia propria.
    return this.device.write([...data]);
  }

  sendFeatureReport(data: readonly number[]): number {
    this.assertOpen();
    return this.device.sendFeatureReport([...data]);
  }

  getFeatureReport(reportId: number, length: number): number[] {
    this.assertOpen();
    return this.device.getFeatureReport(reportId, length);
  }

  readTimeout(timeoutMs: number): number[] {
    this.assertOpen();
    try {
      return this.device.readTimeout(timeoutMs);
    } catch {
      // Timeout sem dados e rotina em HID++: o device so responde quando tem o
      // que dizer. Devolvemos vazio em vez de propagar.
      return [];
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.device.close();
    } catch {
      // Fechando mesmo assim: o handle ja pode ter sido invalidado pelo
      // desligamento do device.
    }
  }
}

/* ------------------------------------------------------------------ *
 * Barramento                                                         *
 * ------------------------------------------------------------------ */

export class NodeHidBus implements HidBus {
  /**
   * Lista os devices HID do sistema.
   *
   * Entradas sem `path` sao descartadas: sem caminho nao da para reabrir o
   * device, e o `path` e a nossa chave de identidade estavel.
   */
  enumerate(): HidDeviceInfo[] {
    const hid = loadNodeHid();
    if (!hid) return [];

    let devices: ReturnType<NodeHidModule['devices']>;
    try {
      devices = hid.devices();
    } catch {
      // A enumeracao pode falhar inteira se o servico HID do Windows estiver
      // em mau estado. Nao e fatal para o resto da deteccao.
      return [];
    }

    const out: HidDeviceInfo[] = [];

    for (const d of devices) {
      if (typeof d.path !== 'string' || d.path.length === 0) continue;

      const info: HidDeviceInfo = {
        path: d.path,
        vendorId: d.vendorId,
        productId: d.productId,
        // Devices nao compostos reportam -1; preservamos o valor como veio.
        interfaceNumber: typeof d.interface === 'number' ? d.interface : -1,
      };

      if (typeof d.usagePage === 'number') info.usagePage = d.usagePage;
      if (typeof d.usage === 'number') info.usage = d.usage;
      if (typeof d.product === 'string') info.product = d.product;
      if (typeof d.manufacturer === 'string') info.manufacturer = d.manufacturer;
      if (typeof d.serialNumber === 'string') info.serialNumber = d.serialNumber;

      out.push(info);
    }

    return out;
  }

  /**
   * Abre um device pelo caminho.
   *
   * `nonExclusive` e deliberado: no Windows, teclados e mouses ja estao
   * abertos pelo driver de classe do sistema. Sem esse flag, o `hid_open_path`
   * falha com acesso negado na maioria dos perifericos que nos interessam.
   */
  open(path: string): HidConnection {
    const hid = loadNodeHid();
    if (!hid) {
      throw new HidUnavailableError(
        `node-hid nao carregou: ${hidLoadError() ?? 'motivo desconhecido'}`,
        loadFailure,
      );
    }

    try {
      const device = new hid.HID(path, { nonExclusive: true }) as unknown as NativeHid;
      return new NodeHidConnection(device, path);
    } catch (err) {
      throw new HidUnavailableError(`nao consegui abrir o device HID ${path}`, err);
    }
  }

  /** Igual a `open`, mas devolve null em vez de lancar. */
  tryOpen(path: string): HidConnection | null {
    try {
      return this.open(path);
    } catch {
      return null;
    }
  }
}

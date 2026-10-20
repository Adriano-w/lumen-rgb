/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 *
 * Portado do OpenRGB (GPL-2.0-or-later):
 *   - i2c_smbus/Windows/i2c_smbus_nvapi.cpp  (layout da transacao I2C, port 1,
 *     endereco deslocado, enumeracao de GPUs)
 *   - i2c_smbus/Windows/i2c_smbus_nvapi.h
 *   - dependencies/NVFC/nvapi.h e nvapi.cpp  (struct NV_I2C_INFO_V3, versao da
 *     struct e os ids de `nvapi_QueryInterface`)
 */

/**
 * I2C de GPU NVIDIA via NVAPI.
 *
 * O NVAPI nao exporta suas funcoes pelo nome. A unica coisa que a `nvapi64.dll`
 * expoe e `nvapi_QueryInterface(id)`: um dicionario de ponteiros de funcao
 * indexado por um id de 32 bits fixado pela NVIDIA. Todo o resto — inclusive o
 * `NvAPI_Initialize` — sai dali. Por isso este arquivo carrega UM simbolo por
 * FFI e decodifica os demais como ponteiros de funcao (`koffi.decode`).
 *
 * Em maquina sem GPU NVIDIA a DLL simplesmente nao existe. Isso nao e erro: e
 * o caso comum em AMD e Intel. `detectNvapiI2cBuses()` devolve lista vazia.
 */
import koffi from 'koffi';

import type { I2cBus } from './types.js';

/* ------------------------------------------------------------------ *
 * Constantes do NVAPI                                                *
 * ------------------------------------------------------------------ */

/** Ids de `nvapi_QueryInterface`. Valores fixos da NVIDIA. */
const NVAPI_ID = {
  Initialize: 0x0150e828,
  Unload: 0xd22bdd7e,
  EnumPhysicalGPUs: 0xe5ac921f,
  GPU_GetFullName: 0xceee8e9f,
  GPU_GetPCIIdentifiers: 0x2ddfb66e,
  I2CWriteEx: 0x283ac65a,
  I2CReadEx: 0x4d7b0709,
} as const;

const NVAPI_OK = 0;
const NVAPI_MAX_PHYSICAL_GPUS = 64;
/** `NV_SHORT_STRING` do NVAPI. */
const NVAPI_SHORT_STRING_MAX = 64;

/**
 * Porta I2C da GPU onde moram os controllers RGB.
 *
 * O OpenRGB fixa a porta 1 para todas as placas. As outras portas sao DDC dos
 * conectores de video — escrever nelas conversa com o monitor, nao com o LED.
 */
const RGB_PORT_ID = 1;

/** `NVAPI_I2C_SPEED_DEFAULT`: deixa o driver escolher o clock. */
const I2C_SPEED_DEFAULT = 0;
/** Campo legado de velocidade; 0xFFFF significa "use `i2cSpeedKhz`". */
const I2C_SPEED_LEGACY_UNUSED = 0xffff;

/** Tamanho maximo de uma transferencia I2C que fazemos. */
const MAX_TRANSFER = 32;

export class NvapiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(`${message} (NVAPI status ${status})`);
    this.name = 'NvapiError';
  }
}

/* ------------------------------------------------------------------ *
 * Tipos FFI                                                          *
 * ------------------------------------------------------------------ */

/**
 * `NV_I2C_INFO_V3`.
 *
 * A ordem dos campos e o alinhamento natural precisam bater byte a byte com o
 * header da NVIDIA: o driver valida o campo `version`, que carrega o
 * `sizeof` da struct. Em x64 isso da 64 bytes.
 */
const NvI2cInfoV3 = koffi.struct('NV_I2C_INFO_V3', {
  version: 'uint32_t',
  displayMask: 'uint32_t',
  isDdcPort: 'uint8_t',
  i2cDevAddress: 'uint8_t',
  i2cRegAddress: 'uint8_t *',
  regAddrSize: 'uint32_t',
  data: 'uint8_t *',
  size: 'uint32_t',
  i2cSpeed: 'uint32_t',
  i2cSpeedKhz: 'uint32_t',
  portId: 'uint8_t',
  isPortIdSet: 'uint32_t',
});

/** `NV_STRUCT_VERSION(NV_I2C_INFO_V3, 3)` = `(3 << 16) | sizeof`. */
const NV_I2C_INFO_VER3 = (3 << 16) | koffi.sizeof(NvI2cInfoV3);

const InitializeProto = koffi.proto('int __stdcall NvapiInitialize()');
const UnloadProto = koffi.proto('int __stdcall NvapiUnload()');
const EnumPhysicalGpusProto = koffi.proto(
  'int __stdcall NvapiEnumPhysicalGPUs(_Out_ void **handles, _Out_ int32_t *count)',
);
const GetFullNameProto = koffi.proto(
  'int __stdcall NvapiGpuGetFullName(void *gpu, _Out_ uint8_t *name)',
);
const GetPciIdentifiersProto = koffi.proto(
  'int __stdcall NvapiGpuGetPCIIdentifiers(void *gpu, _Out_ uint32_t *devId, _Out_ uint32_t *subSysId, _Out_ uint32_t *revId, _Out_ uint32_t *extDevId)',
);
const I2cExProto = koffi.proto(
  'int __stdcall NvapiI2cEx(void *gpu, void *i2cInfo, _Out_ uint32_t *unknown)',
);

type GpuHandle = unknown;

interface NvapiBindings {
  enumPhysicalGpus(handles: unknown[], count: number[]): number;
  getFullName(gpu: GpuHandle, name: Uint8Array): number;
  getPciIdentifiers(
    gpu: GpuHandle,
    devId: number[],
    subSysId: number[],
    revId: number[],
    extDevId: number[],
  ): number;
  i2cRead(gpu: GpuHandle, info: unknown, unknown: number[]): number;
  i2cWrite(gpu: GpuHandle, info: unknown, unknown: number[]): number;
  unload(): number;
}

/* ------------------------------------------------------------------ *
 * Carga                                                              *
 * ------------------------------------------------------------------ */

let bindings: NvapiBindings | null = null;
/** `true` depois de uma tentativa de carga fracassada; nao repetimos. */
let loadAttempted = false;
let loadError: string | null = null;

const DLL_CANDIDATES = ['nvapi64.dll', 'C:\\Windows\\System32\\nvapi64.dll'];

function loadBindings(): NvapiBindings | null {
  if (bindings) return bindings;
  if (loadAttempted) return null;
  loadAttempted = true;

  try {
    let lib: ReturnType<typeof koffi.load> | null = null;
    for (const candidate of DLL_CANDIDATES) {
      try {
        lib = koffi.load(candidate);
        break;
      } catch {
        // Proxima candidata. Sem GPU NVIDIA nenhuma existe.
      }
    }

    if (!lib) {
      loadError = 'nvapi64.dll nao encontrada (sistema sem GPU NVIDIA ou sem driver)';
      return null;
    }

    const queryInterfacePtr = lib.func(
      'void * __stdcall nvapi_QueryInterface(uint32_t id)',
    ) as (id: number) => unknown;

    /** Resolve um id para funcao chamavel. Null quando o driver nao a expoe. */
    const resolve = <T>(id: number, proto: ReturnType<typeof koffi.proto>): T | null => {
      const ptr = queryInterfacePtr(id);
      if (!ptr) return null;
      return koffi.decode(ptr, proto) as T;
    };

    const initialize = resolve<() => number>(NVAPI_ID.Initialize, InitializeProto);
    if (!initialize) {
      loadError = 'NvAPI_Initialize nao esta exposto por esta versao do driver';
      return null;
    }

    const status = initialize();
    if (status !== NVAPI_OK) {
      loadError = `NvAPI_Initialize falhou com status ${status}`;
      return null;
    }

    const enumPhysicalGpus = resolve<NvapiBindings['enumPhysicalGpus']>(
      NVAPI_ID.EnumPhysicalGPUs,
      EnumPhysicalGpusProto,
    );
    const getFullName = resolve<NvapiBindings['getFullName']>(
      NVAPI_ID.GPU_GetFullName,
      GetFullNameProto,
    );
    const getPciIdentifiers = resolve<NvapiBindings['getPciIdentifiers']>(
      NVAPI_ID.GPU_GetPCIIdentifiers,
      GetPciIdentifiersProto,
    );
    const i2cRead = resolve<NvapiBindings['i2cRead']>(NVAPI_ID.I2CReadEx, I2cExProto);
    const i2cWrite = resolve<NvapiBindings['i2cWrite']>(NVAPI_ID.I2CWriteEx, I2cExProto);
    const unload = resolve<NvapiBindings['unload']>(NVAPI_ID.Unload, UnloadProto);

    if (!enumPhysicalGpus || !getPciIdentifiers || !i2cRead || !i2cWrite) {
      loadError = 'driver NVIDIA nao expoe o conjunto I2C do NVAPI';
      return null;
    }

    bindings = {
      enumPhysicalGpus,
      getFullName: getFullName ?? (() => -1),
      getPciIdentifiers,
      i2cRead,
      i2cWrite,
      unload: unload ?? (() => 0),
    };
    return bindings;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    return null;
  }
}

/** Motivo pelo qual o NVAPI nao esta disponivel. `null` quando esta. */
export function nvapiLoadError(): string | null {
  if (loadBindings()) return null;
  return loadError ?? 'motivo desconhecido';
}

/* ------------------------------------------------------------------ *
 * Identidade PCI                                                     *
 * ------------------------------------------------------------------ */

/**
 * Um barramento I2C que sabe em que placa esta.
 *
 * Os controllers de GPU precisam disso: duas placas com o mesmo chip NVIDIA
 * podem ter controllers RGB completamente diferentes, e so o subsystem id
 * (o id do fabricante da placa) separa as duas.
 */
export interface PciI2cBus extends I2cBus {
  readonly pciVendorId: number;
  readonly pciDeviceId: number;
  readonly pciSubsystemVendorId: number;
  readonly pciSubsystemDeviceId: number;
  readonly gpuIndex: number;
  readonly gpuName: string;
}

/** Type guard estrutural: serve para NVAPI hoje e para ADL (AMD) amanha. */
export function hasPciIdentity(bus: I2cBus): bus is PciI2cBus {
  const candidate = bus as Partial<PciI2cBus>;
  return (
    typeof candidate.pciVendorId === 'number' &&
    typeof candidate.pciDeviceId === 'number' &&
    typeof candidate.pciSubsystemVendorId === 'number' &&
    typeof candidate.pciSubsystemDeviceId === 'number'
  );
}

/* ------------------------------------------------------------------ *
 * Barramento                                                         *
 * ------------------------------------------------------------------ */

/**
 * Um barramento I2C ancorado numa GPU fisica.
 *
 * **Enquadramento das transacoes.** O contrato `I2cBus` fala em
 * `(endereco, comando, dados)`, mas os controllers RGB de GPU nao usam
 * registradores no sentido SMBus: eles esperam uma fila de transacoes de UM
 * byte, cada uma com seu proprio START/STOP — e exatamente o que o OpenRGB faz
 * com `i2c_smbus_write_byte` repetido. Juntar tudo numa transferencia so muda o
 * que aparece no fio e alguns firmwares nao reconhecem. Por isso:
 *
 *  - `write(addr, command, data)` envia `command` e depois cada byte de `data`
 *    como transacoes separadas de 1 byte.
 *  - `read(addr, command, length)` envia `command` (quando >= 0) como uma
 *    transacao de 1 byte e depois faz `length` leituras de 1 byte.
 *  - `command` negativo em `read` significa "leia cru, sem escrever nada".
 *
 * **Velocidade.** Cada transacao atravessa o driver de video. Sao dezenas de
 * microssegundos na melhor das hipoteses e frequentemente mais. Nao ha retry
 * aqui de proposito: um laco de repeticao num barramento assim trava a UI e
 * nao conserta nada.
 */
export class NvapiI2c implements PciI2cBus {
  readonly name: string;

  /**
   * Memoria estavel reutilizada por transacao.
   *
   * Sao `Buffer`s do proprio JS, e nao `koffi.alloc` + `koffi.view`, por um
   * motivo concreto: o **sandbox do V8** — ativo no Electron — proibe criar um
   * `ArrayBuffer` sobre memoria externa. `koffi.view()` faz exatamente isso, e
   * o resultado nao e uma excecao: e um crash fatal do V8 dentro do construtor.
   * Em Node puro o mesmo codigo funciona, o que torna a falha facil de nao
   * perceber em teste.
   *
   * Um `Buffer` e memoria que o V8 ja conhece, e o koffi a repassa como
   * ponteiro sem copiar.
   */
  private readonly infoBuf: Buffer;
  private readonly dataBuf: Buffer;
  private readonly statusOut: number[] = [0];

  constructor(
    private readonly handle: GpuHandle,
    readonly gpuIndex: number,
    readonly gpuName: string,
    readonly pciVendorId: number,
    readonly pciDeviceId: number,
    readonly pciSubsystemVendorId: number,
    readonly pciSubsystemDeviceId: number,
  ) {
    this.name = `NVAPI I2C na GPU ${gpuIndex} (${gpuName})`;

    this.infoBuf = Buffer.alloc(koffi.sizeof(NvI2cInfoV3));
    this.dataBuf = Buffer.alloc(MAX_TRANSFER);
  }

  /**
   * Monta a struct e dispara uma transacao de um byte cru.
   *
   * `regAddrSize` fica sempre em 0: nao usamos o endereco de registrador do
   * NVAPI porque estes controllers nao falam SMBus — eles esperam uma fila de
   * transacoes de um byte, que e como o OpenRGB emite `i2c_smbus_write_byte` e
   * `i2c_smbus_read_byte`.
   */
  private transfer(addr: number, isWrite: boolean, payloadLength: number): number {
    const api = loadBindings();
    if (!api) throw new NvapiError('NVAPI indisponivel', -1);

    koffi.encode(this.infoBuf, NvI2cInfoV3, {
      version: NV_I2C_INFO_VER3,
      displayMask: 0,
      isDdcPort: 0,
      // O NVAPI quer o endereco de 7 bits ja deslocado para o formato do fio.
      i2cDevAddress: (addr << 1) & 0xff,
      i2cRegAddress: null,
      regAddrSize: 0,
      data: this.dataBuf,
      size: payloadLength,
      i2cSpeed: I2C_SPEED_LEGACY_UNUSED,
      i2cSpeedKhz: I2C_SPEED_DEFAULT,
      portId: RGB_PORT_ID,
      isPortIdSet: 1,
    });

    this.statusOut[0] = 0;
    const status = isWrite
      ? api.i2cWrite(this.handle, this.infoBuf, this.statusOut)
      : api.i2cRead(this.handle, this.infoBuf, this.statusOut);

    return status;
  }

  /** Uma transacao de escrita de um unico byte, sem registrador. */
  private writeRawByte(addr: number, value: number): void {
    this.dataBuf[0] = value & 0xff;
    const status = this.transfer(addr, true, 1);
    if (status !== NVAPI_OK) {
      throw new NvapiError(`escrita I2C em 0x${addr.toString(16)} falhou`, status);
    }
  }

  /** Uma transacao de leitura de um unico byte, sem registrador. */
  private readRawByte(addr: number): number {
    this.dataBuf[0] = 0;
    const status = this.transfer(addr, false, 1);
    if (status !== NVAPI_OK) {
      throw new NvapiError(`leitura I2C em 0x${addr.toString(16)} falhou`, status);
    }
    return this.dataBuf[0]!;
  }

  read(addr: number, command: number, length: number): Uint8Array {
    if (length < 0 || length > MAX_TRANSFER) {
      throw new NvapiError(`comprimento de leitura invalido: ${length}`, -1);
    }

    if (command >= 0) {
      this.writeRawByte(addr, command);
    }

    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = this.readRawByte(addr);
    }
    return out;
  }

  write(addr: number, command: number, data: Uint8Array): void {
    if (data.length > MAX_TRANSFER) {
      throw new NvapiError(`escrita longa demais: ${data.length} bytes`, -1);
    }

    this.writeRawByte(addr, command);
    for (const byte of data) {
      this.writeRawByte(addr, byte);
    }
  }

  /**
   * Existe algo nesse endereco?
   *
   * So leitura, nunca escrita — a mesma regra do SMBus. Uma varredura que
   * escreve pode acertar um device que nao esperava o byte.
   */
  probe(addr: number): boolean {
    try {
      this.readRawByte(addr);
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Deteccao                                                           *
 * ------------------------------------------------------------------ */

function decodeShortString(buf: Uint8Array): string {
  const end = buf.indexOf(0);
  const slice = end >= 0 ? buf.subarray(0, end) : buf;
  return Buffer.from(slice).toString('latin1').trim();
}

/**
 * Enumera as GPUs NVIDIA e devolve um barramento I2C por placa.
 *
 * Nunca lanca. Sem GPU NVIDIA, sem driver, ou com um driver velho demais para
 * expor o conjunto I2C, a resposta e uma lista vazia.
 */
export function detectNvapiI2cBuses(log?: (msg: string) => void): NvapiI2c[] {
  const api = loadBindings();
  if (!api) {
    log?.(`NVAPI indisponivel: ${loadError ?? 'motivo desconhecido'}`);
    return [];
  }

  const buses: NvapiI2c[] = [];

  try {
    const handles: unknown[] = new Array<unknown>(NVAPI_MAX_PHYSICAL_GPUS).fill(null);
    const countOut = [0];

    const status = api.enumPhysicalGpus(handles, countOut);
    if (status !== NVAPI_OK) {
      log?.(`NvAPI_EnumPhysicalGPUs falhou com status ${status}`);
      return [];
    }

    const count = Math.min(countOut[0]!, NVAPI_MAX_PHYSICAL_GPUS);

    for (let i = 0; i < count; i++) {
      const handle = handles[i];
      if (!handle) continue;

      const devIdOut = [0];
      const subSysOut = [0];
      const revOut = [0];
      const extDevOut = [0];

      const pciStatus = api.getPciIdentifiers(handle, devIdOut, subSysOut, revOut, extDevOut);
      if (pciStatus !== NVAPI_OK) {
        log?.(`GPU ${i}: NvAPI_GPU_GetPCIIdentifiers falhou (status ${pciStatus}), ignorando`);
        continue;
      }

      // Os dois ids vem empacotados: device na metade alta, vendor na baixa.
      const deviceId = (devIdOut[0]! >>> 16) & 0xffff;
      const vendorId = devIdOut[0]! & 0xffff;
      const subDeviceId = (subSysOut[0]! >>> 16) & 0xffff;
      const subVendorId = subSysOut[0]! & 0xffff;

      let fullName = `GPU ${i}`;
      const nameBuf = new Uint8Array(NVAPI_SHORT_STRING_MAX);
      if (api.getFullName(handle, nameBuf) === NVAPI_OK) {
        const decoded = decodeShortString(nameBuf);
        if (decoded) fullName = decoded;
      }

      const hex = (v: number): string => v.toString(16).padStart(4, '0').toUpperCase();
      log?.(
        `GPU ${i}: ${fullName} — ${hex(vendorId)}:${hex(deviceId)} ` +
          `subsistema ${hex(subVendorId)}:${hex(subDeviceId)}`,
      );

      buses.push(
        new NvapiI2c(handle, i, fullName, vendorId, deviceId, subVendorId, subDeviceId),
      );
    }
  } catch (err) {
    log?.(`NVAPI: enumeracao falhou (${err instanceof Error ? err.message : String(err)})`);
    return [];
  }

  return buses;
}

/** Devolve o NVAPI ao driver. Opcional: o Windows limpa no fim do processo. */
export function unloadNvapi(): void {
  try {
    bindings?.unload();
  } catch {
    // Sem consequencia pratica no encerramento.
  }
}

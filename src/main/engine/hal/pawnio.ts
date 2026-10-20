/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Ponte para o PawnIO, o driver que da acesso a SMBus no Windows.
 *
 * Por que um driver de terceiros continua na jogada num app "autossuficiente":
 * nao existe acesso a portas de IO no Windows em modo usuario. Alguem tem que
 * estar no kernel. As alternativas seriam carregar um driver de port-IO
 * irrestrito (WinRing0, MsIo da ASRock — ambos permitem escrita arbitraria em
 * memoria fisica, e o primeiro esta na blocklist da Microsoft) ou assinar um
 * driver proprio, o que exige certificado EV mais atestacao da Microsoft.
 *
 * O PawnIO e a opcao correta: assinado, compativel com Memory Integrity, e
 * executa bytecode verificado em sandbox em vez de expor IO cru. E um driver,
 * nao um aplicativo — nada dele disputa o barramento com a gente.
 *
 * O acesso e por FFI (koffi, binarios prebuilt), entao nao ha etapa de
 * compilacao nativa no build do Lumen.
 */
import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';

const DLL_CANDIDATES = [
  'C:\\Program Files\\PawnIO\\PawnIOLib.dll',
  'C:\\Program Files (x86)\\PawnIO\\PawnIOLib.dll',
];

export class PawnIoError extends Error {
  constructor(
    message: string,
    readonly hresult: number,
  ) {
    super(`${message} (HRESULT 0x${(hresult >>> 0).toString(16).padStart(8, '0')})`);
    this.name = 'PawnIoError';
  }
}

export class PawnIoUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'not-installed' | 'not-elevated' | 'driver-stopped',
  ) {
    super(message);
    this.name = 'PawnIoUnavailableError';
  }
}

interface PawnIoBindings {
  version(out: number[]): number;
  open(out: unknown[]): number;
  load(handle: unknown, blob: Uint8Array, size: number): number;
  execute(
    handle: unknown,
    name: string,
    input: BigUint64Array,
    inSize: number,
    output: BigUint64Array,
    outSize: number,
    returned: number[],
  ): number;
  close(handle: unknown): number;
}

let bindings: PawnIoBindings | null = null;

function loadBindings(): PawnIoBindings {
  if (bindings) return bindings;

  const dll = DLL_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  if (!dll) {
    throw new PawnIoUnavailableError(
      'PawnIO nao esta instalado. Instale de https://pawnio.eu para controlar placa-mae e memoria.',
      'not-installed',
    );
  }

  const lib = koffi.load(dll);
  bindings = {
    version: lib.func('int __stdcall pawnio_version(_Out_ uint32_t *version)') as PawnIoBindings['version'],
    open: lib.func('int __stdcall pawnio_open(_Out_ void **handle)') as PawnIoBindings['open'],
    load: lib.func(
      'int __stdcall pawnio_load(void *handle, uint8_t *blob, size_t size)',
    ) as PawnIoBindings['load'],
    execute: lib.func(
      'int __stdcall pawnio_execute(void *handle, const char *name, uint64_t *in, size_t in_size, _Out_ uint64_t *out, size_t out_size, _Out_ size_t *return_size)',
    ) as PawnIoBindings['execute'],
    close: lib.func('int __stdcall pawnio_close(void *handle)') as PawnIoBindings['close'],
  };
  return bindings;
}

export function isPawnIoInstalled(): boolean {
  return DLL_CANDIDATES.some((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

export function getPawnIoVersion(): string | null {
  try {
    const api = loadBindings();
    const out = [0];
    if (api.version(out) !== 0) return null;
    const v = out[0]!;
    return `${(v >> 16) & 0xff}.${(v >> 8) & 0xff}.${v & 0xff}`;
  } catch {
    return null;
  }
}

/**
 * Um executor PawnIO com um modulo carregado.
 *
 * Cada modulo (`.bin`) e bytecode verificado que implementa um transporte —
 * `SmbusPIIX4.bin` para chipsets AMD, `SmbusI801.bin` para Intel.
 */
export class PawnIoModule {
  private handle: unknown;
  private closed = false;

  private constructor(handle: unknown, readonly moduleName: string) {
    this.handle = handle;
  }

  /** Abre um executor e carrega um modulo. Lanca se nao der. */
  static load(modulePath: string): PawnIoModule {
    const api = loadBindings();

    const handleOut: unknown[] = [null];
    const openStatus = api.open(handleOut);
    if (openStatus !== 0) {
      // E_ACCESSDENIED, ou o driver nao esta rodando. Na pratica, quase
      // sempre e falta de elevacao.
      throw new PawnIoUnavailableError(
        'Nao consegui abrir o PawnIO. O backend do Lumen precisa rodar como administrador.',
        openStatus === -2147024891 ? 'not-elevated' : 'driver-stopped',
      );
    }

    const handle = handleOut[0];
    const blob = fs.readFileSync(modulePath);
    const loadStatus = api.load(handle, blob, blob.length);
    if (loadStatus !== 0) {
      api.close(handle);
      throw new PawnIoError(`nao consegui carregar ${path.basename(modulePath)}`, loadStatus);
    }

    return new PawnIoModule(handle, path.basename(modulePath));
  }

  /**
   * Chama uma funcao do modulo.
   *
   * Os buffers sao realocados a cada chamada de proposito: transferencias
   * SMBus sao lentas o bastante (milissegundos) para que a alocacao nao
   * importe, e buffers compartilhados seriam uma armadilha de concorrencia.
   */
  execute(name: string, input: readonly (number | bigint)[], outCount: number): BigUint64Array {
    if (this.closed) throw new Error('modulo PawnIO ja foi fechado');

    const api = loadBindings();
    const inBuf = new BigUint64Array(Math.max(1, input.length));
    // `bigint` e aceito direto porque palavras de 64 bits nao cabem em
    // `number`: acima de 2^53 a conversao perde bits e o payload chega
    // corrompido ao driver (o sintoma e E_INVALIDARG, nao um valor errado).
    for (let i = 0; i < input.length; i++) {
      const v = input[i]!;
      inBuf[i] = typeof v === 'bigint' ? v : BigInt(v);
    }

    const outBuf = new BigUint64Array(Math.max(1, outCount));
    const returned = [0];

    const status = api.execute(
      this.handle,
      name,
      inBuf,
      input.length,
      outBuf,
      outCount,
      returned,
    );
    if (status !== 0) throw new PawnIoError(`${this.moduleName}:${name}`, status);
    return outBuf;
  }

  /** Igual a `execute`, mas devolve null em erro em vez de lancar. */
  tryExecute(
    name: string,
    input: readonly (number | bigint)[],
    outCount: number,
  ): BigUint64Array | null {
    try {
      return this.execute(name, input, outCount);
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      loadBindings().close(this.handle);
    } catch {
      // fechando mesmo assim
    }
    this.handle = null;
  }
}

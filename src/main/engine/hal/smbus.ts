/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 *
 * A convencao de chamada do `ioctl_smbus_xfer` e a ABI SMBus do kernel Linux,
 * usada tambem pelos modulos do PawnIO.
 */

/**
 * Barramento SMBus sobre PawnIO.
 *
 * Tres coisas aqui existem por causa de hardware real, nao de elegancia:
 *
 *  1. **Mutex global.** `Global\Access_SMBUS.HTP.Method` e o mutex que a
 *     industria inteira usa para arbitrar o SMBus no Windows — ASRock, MSI,
 *     Corsair e OpenRGB respeitam o mesmo nome. Sem ele, duas transacoes se
 *     intercalam e o resultado nao e "a ultima vence": e lixo. No mesmo
 *     barramento mora o SPD das memorias, entao lixo ali e serio.
 *
 *  2. **Serializacao em processo.** O mutex nomeado protege entre processos;
 *     esta classe tambem serializa dentro do nosso, porque o executor do
 *     PawnIO nao garante ordem entre chamadas concorrentes.
 *
 *  3. **Varredura so com leitura.** `probe` usa leitura de byte. Uma varredura
 *     que escreve pode reprogramar um SPD e deixar a memoria sem bootar.
 */
import path from 'node:path';

import { PawnIoModule } from './pawnio.js';
import { SMBUS_SIZE, type SmbusBus } from './types.js';

const SMBUS_WRITE = 0;
const SMBUS_READ = 1;

/** Entradas que o `ioctl_smbus_xfer` espera: addr, rw, cmd, size, + dados. */
const XFER_IN_SIZE = 9;
const XFER_OUT_SIZE = 5;

/** Tamanho maximo de um bloco SMBus. */
const MAX_BLOCK = 32;

/** Pausa entre tentativas de sondagem. */
const PROBE_RETRY_MS = 8;

/**
 * Pausa sincrona de verdade.
 *
 * O acesso a SMBus e sincrono por natureza (FFI bloqueante), entao nao da para
 * usar `await`. `Atomics.wait` dorme sem queimar CPU, ao contrario de um laco
 * de espera ocupada.
 */
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

export class SmbusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmbusError';
  }
}

/* ------------------------------------------------------------------ *
 * Mutex global entre processos                                       *
 * ------------------------------------------------------------------ */

/**
 * O mutex nomeado do Windows precisa de `CreateMutexW`/`WaitForSingleObject`,
 * que chegam por FFI. Quando nao der para obter (falta de permissao, por
 * exemplo), seguimos sem ele: e pior do que ter, mas melhor do que nao
 * funcionar — e a serializacao em processo ainda vale.
 */
interface GlobalLock {
  acquire(): void;
  release(): void;
}

function createGlobalLock(): GlobalLock {
  try {
    // Import tardio: se o koffi falhar, caimos no lock nulo em vez de
    // derrubar o modulo inteiro.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as typeof import('koffi');
    const k32 = koffi.load('kernel32.dll');
    const CreateMutexW = k32.func(
      'void * __stdcall CreateMutexW(void *attrs, int initialOwner, const char16_t *name)',
    ) as (attrs: null, initialOwner: number, name: string) => unknown;
    const WaitForSingleObject = k32.func(
      'uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)',
    ) as (handle: unknown, ms: number) => number;
    const ReleaseMutex = k32.func('int __stdcall ReleaseMutex(void *handle)') as (
      handle: unknown,
    ) => number;

    const handle = CreateMutexW(null, 0, 'Global\\Access_SMBUS.HTP.Method');
    if (!handle) return nullLock();

    return {
      acquire: () => {
        // 5s e generoso: uma transacao SMBus leva milissegundos. Se estourar,
        // seguimos mesmo assim — travar a UI seria pior.
        WaitForSingleObject(handle, 5000);
      },
      release: () => {
        ReleaseMutex(handle);
      },
    };
  } catch {
    return nullLock();
  }
}

function nullLock(): GlobalLock {
  return { acquire: () => undefined, release: () => undefined };
}

let globalLock: GlobalLock | null = null;

/* ------------------------------------------------------------------ *
 * Barramento                                                         *
 * ------------------------------------------------------------------ */

export class PawnIoSmbus implements SmbusBus {
  readonly name: string;

  constructor(
    private readonly module: PawnIoModule,
    /**
     * Porta do PIIX4, ou `null` quando o chipset nao tem selecao de porta.
     *
     * O PIIX4 (AMD) expoe dois barramentos atras de um unico modulo e exige
     * escolher um antes de cada transacao. O i801 (Intel) expoe um so, e o
     * modulo dele nem exporta `ioctl_piix4_port_sel` — chamar daria erro.
     */
    private readonly port: number | null,
    label: string,
  ) {
    this.name = label;
    globalLock ??= createGlobalLock();
  }

  /**
   * Abre os barramentos de um chipset AMD (PIIX4).
   *
   * Um unico executor serve as duas portas; `ioctl_piix4_port_sel` troca entre
   * elas antes de cada transacao.
   */
  static openPiix4(moduleDir: string): PawnIoSmbus[] {
    const modulePath = path.join(moduleDir, 'SmbusPIIX4.bin');
    const mod = PawnIoModule.load(modulePath);

    const buses: PawnIoSmbus[] = [];
    for (const port of [0, 1]) {
      const probe = mod.tryExecute('ioctl_piix4_port_sel', [port], 1);
      if (probe !== null) {
        buses.push(new PawnIoSmbus(mod, port, `SMBus PIIX4 ${port}`));
      }
    }

    if (buses.length === 0) {
      mod.close();
      throw new SmbusError('nenhuma porta SMBus do PIIX4 respondeu');
    }
    return buses;
  }

  /**
   * Abre o barramento de um chipset Intel (i801).
   *
   * Mesma interface de modulo do PIIX4 menos a selecao de porta: o i801 tem
   * um barramento so. O proprio `PawnIO_LoadModuleEx` recusa o modulo quando
   * o chipset nao e compativel, entao carregar com sucesso ja e a deteccao —
   * nao ha sondagem a fazer depois.
   */
  static openI801(moduleDir: string): PawnIoSmbus[] {
    const modulePath = path.join(moduleDir, 'SmbusI801.bin');
    const mod = PawnIoModule.load(modulePath);
    return [new PawnIoSmbus(mod, null, 'SMBus i801')];
  }

  private xfer(
    addr: number,
    readWrite: number,
    command: number,
    size: number,
    data: readonly (number | bigint)[] = [],
  ): BigUint64Array {
    const lock = globalLock ?? nullLock();
    lock.acquire();
    try {
      // A porta e estado do modulo, nao da transacao: precisa ser reafirmada
      // porque outro barramento do mesmo modulo pode te-la trocado.
      // No i801 nao existe porta, e o ioctl nem existe no modulo.
      if (this.port !== null) {
        this.module.execute('ioctl_piix4_port_sel', [this.port], 1);
      }

      const input = new Array<number | bigint>(XFER_IN_SIZE).fill(0);
      input[0] = addr;
      input[1] = readWrite;
      input[2] = command;
      input[3] = size;
      for (let i = 0; i < data.length && 4 + i < XFER_IN_SIZE; i++) {
        input[4 + i] = data[i]!;
      }

      return this.module.execute('ioctl_smbus_xfer', input, XFER_OUT_SIZE);
    } finally {
      lock.release();
    }
  }

  /**
   * Empacota bytes em palavras de 64 bits, como a union `i2c_smbus_data`.
   *
   * Devolve `bigint`, nao `number`: uma palavra cheia de 64 bits nao cabe em
   * um `number` (precisao vai so ate 2^53) e a perda silenciosa de bits chega
   * ao driver como payload invalido.
   */
  private static packBytes(bytes: readonly number[]): bigint[] {
    const words: bigint[] = [];
    for (let i = 0; i < bytes.length; i += 8) {
      let w = 0n;
      for (let j = 0; j < 8 && i + j < bytes.length; j++) {
        w |= BigInt(bytes[i + j]! & 0xff) << BigInt(j * 8);
      }
      words.push(w);
    }
    return words;
  }

  private static unpackBytes(words: BigUint64Array, count: number): Uint8Array {
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const w = words[Math.floor(i / 8)] ?? 0n;
      out[i] = Number((w >> BigInt((i % 8) * 8)) & 0xffn);
    }
    return out;
  }

  readByte(addr: number): number {
    const out = this.xfer(addr, SMBUS_READ, 0, SMBUS_SIZE.BYTE);
    return Number(out[0]! & 0xffn);
  }

  readByteData(addr: number, command: number): number {
    const out = this.xfer(addr, SMBUS_READ, command, SMBUS_SIZE.BYTE_DATA);
    return Number(out[0]! & 0xffn);
  }

  readWordData(addr: number, command: number): number {
    const out = this.xfer(addr, SMBUS_READ, command, SMBUS_SIZE.WORD_DATA);
    return Number(out[0]! & 0xffffn);
  }

  readBlockData(addr: number, command: number): Uint8Array {
    const out = this.xfer(addr, SMBUS_READ, command, SMBUS_SIZE.BLOCK_DATA);
    // No formato de bloco, o primeiro byte e a contagem.
    const raw = PawnIoSmbus.unpackBytes(out, MAX_BLOCK + 1);
    const count = Math.min(raw[0] ?? 0, MAX_BLOCK);
    return raw.slice(1, 1 + count);
  }

  writeByte(addr: number, value: number): void {
    this.xfer(addr, SMBUS_WRITE, value & 0xff, SMBUS_SIZE.BYTE);
  }

  writeByteData(addr: number, command: number, value: number): void {
    this.xfer(addr, SMBUS_WRITE, command, SMBUS_SIZE.BYTE_DATA, [value & 0xff]);
  }

  writeWordData(addr: number, command: number, value: number): void {
    // A union `i2c_smbus_data` guarda a palavra como UM `u16`, entao ela vai
    // numa unica entrada — nao como dois bytes em entradas separadas.
    this.xfer(addr, SMBUS_WRITE, command, SMBUS_SIZE.WORD_DATA, [value & 0xffff]);
  }

  writeBlockData(addr: number, command: number, data: Uint8Array): void {
    if (data.length > MAX_BLOCK) {
      throw new SmbusError(`bloco SMBus de ${data.length} bytes excede o maximo de ${MAX_BLOCK}`);
    }

    // Bloco de comprimento zero nao existe no SMBus, e o modulo do PawnIO o
    // recusa com E_INVALIDARG. Alguns firmwares (o ASRock Polychrome v2, por
    // exemplo) usam essa escrita como um "toque" num registrador de controle.
    //
    // No barramento, um bloco de comprimento 0 seria `cmd, 0x00` — exatamente
    // os mesmos bytes de uma escrita byte_data com valor 0. Entao traduzimos,
    // e o firmware ve a transacao que espera.
    if (data.length === 0) {
      this.writeByteData(addr, command, 0);
      return;
    }

    const payload = PawnIoSmbus.packBytes([data.length, ...data]);
    this.xfer(addr, SMBUS_WRITE, command, SMBUS_SIZE.BLOCK_DATA, payload);
  }

  /**
   * True se houver um device respondendo no endereco.
   *
   * Tenta mais de uma vez de proposito. O SMBus e um barramento compartilhado e
   * genuinamente instavel: uma transacao isolada pode falhar porque o
   * controlador ainda esta ocupado com a anterior, porque outro mestre falou
   * no meio, ou porque o device acabou de sair de um ciclo de escrita. Medido
   * nesta maquina, a deteccao da memoria Kingston oscilava entre execucoes
   * justamente por isso — uma unica sondagem condenava um endereco que estava
   * perfeitamente vivo.
   *
   * Leitura apenas: nunca escrevemos durante uma varredura.
   */
  probe(addr: number, attempts = 3): boolean {
    for (let i = 0; i < attempts; i++) {
      try {
        this.xfer(addr, SMBUS_READ, 0, SMBUS_SIZE.BYTE_DATA);
        return true;
      } catch {
        if (i < attempts - 1) sleepSync(PROBE_RETRY_MS);
      }
    }
    return false;
  }

  /** Varre a faixa util do barramento. Somente leitura. */
  scan(from = 0x08, to = 0x77): number[] {
    const found: number[] = [];
    for (let addr = from; addr <= to; addr++) {
      if (this.probe(addr)) found.push(addr);
    }
    return found;
  }
}

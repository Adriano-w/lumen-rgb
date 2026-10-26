/*
 * Lumen — GPL-2.0-or-later.
 *
 * O controlador da placa-mae ainda esta no barramento?
 *
 * Ele parou de responder em 0x6A. Antes de concluir que travou, vale testar
 * mais de um tipo de transacao: a varredura usa leitura de byte com
 * registrador, e um firmware pode estar surdo para essa e responder a outra.
 *
 * Somente leitura. Rode ELEVADO.
 */
import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';

const lib = koffi.load('C:\\Program Files\\PawnIO\\PawnIOLib.dll');
const pawnio_open = lib.func('int __stdcall pawnio_open(_Out_ void **handle)');
const pawnio_load = lib.func('int __stdcall pawnio_load(void *handle, uint8_t *blob, size_t size)');
const pawnio_execute = lib.func(
  'int __stdcall pawnio_execute(void *handle, const char *name, uint64_t *in, size_t in_size, _Out_ uint64_t *out, size_t out_size, _Out_ size_t *return_size)',
);
const pawnio_close = lib.func('int __stdcall pawnio_close(void *handle)');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const hr = (c) => `0x${(c >>> 0).toString(16).padStart(8, '0')}`;

const h = [null];
if (pawnio_open(h) !== 0) { console.error('rode como administrador'); process.exit(1); }
const handle = h[0];
pawnio_load(handle, fs.readFileSync(path.join(process.cwd(), 'resources', 'pawnio', 'SmbusPIIX4.bin')), 42404);

function exec(name, input, outCount) {
  const inBuf = new BigUint64Array(Math.max(1, input.length));
  input.forEach((v, i) => { inBuf[i] = typeof v === 'bigint' ? v : BigInt(v); });
  const outBuf = new BigUint64Array(Math.max(1, outCount));
  const ret = [0];
  return { status: pawnio_execute(handle, name, inBuf, input.length, outBuf, outCount, ret), out: outBuf };
}

function xfer(port, addr, rw, cmd, size, data) {
  exec('ioctl_piix4_port_sel', [port], 1);
  const input = new Array(9).fill(0);
  input[0] = addr; input[1] = rw; input[2] = cmd; input[3] = size;
  if (data !== undefined) input[4] = data;
  return exec('ioctl_smbus_xfer', input, 5);
}

const READ = 1;
const SZ = { QUICK: 0, BYTE: 1, BYTE_DATA: 2, WORD_DATA: 3, BLOCK_DATA: 5 };

console.log('=== 0x6A, varios tipos de transacao, nas duas portas ===\n');
for (const port of [0, 1]) {
  console.log(`porta ${port}:`);
  for (const [nome, size, cmd] of [
    ['quick', SZ.QUICK, 0],
    ['read byte', SZ.BYTE, 0],
    ['read byte_data reg 0x00', SZ.BYTE_DATA, 0x00],
    ['read word_data reg 0x00', SZ.WORD_DATA, 0x00],
    ['read block reg 0x00 (versao fw)', SZ.BLOCK_DATA, 0x00],
    ['read block reg 0x30 (modo)', SZ.BLOCK_DATA, 0x30],
  ]) {
    let s;
    try { s = xfer(port, 0x6a, READ, cmd, size).status; } catch { s = -1; }
    console.log(`  ${hr(s)}  ${nome}${s === 0 ? '   RESPONDEU' : ''}`);
    sleep(20);
  }
  console.log('');
}

console.log('=== varredura completa da porta 1, com mais tentativas ===');
const found = [];
for (let addr = 0x08; addr <= 0x77; addr++) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = xfer(1, addr, READ, 0, SZ.BYTE_DATA);
    if (r.status === 0) { found.push(addr); break; }
    sleep(5);
  }
}
console.log(`  responderam: ${found.map((a) => `0x${a.toString(16).toUpperCase()}`).join(', ') || 'nenhum'}`);

console.log('\n=== vizinhos de 0x6A (o endereco pode ter mudado) ===');
for (const addr of [0x60, 0x64, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x70, 0x74]) {
  const a = xfer(0, addr, READ, 0, SZ.BYTE_DATA).status === 0;
  const b = xfer(1, addr, READ, 0, SZ.BYTE_DATA).status === 0;
  if (a || b) console.log(`  0x${addr.toString(16).toUpperCase()}: porta0=${a} porta1=${b}`);
  sleep(10);
}

pawnio_close(handle);
console.log('\npronto');

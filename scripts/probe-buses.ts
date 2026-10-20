/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Validacao da camada de transporte, independente dos drivers de device.
 *
 * Responde a pergunta "o Lumen consegue falar com o barramento?" antes de
 * qualquer pergunta sobre device especifico. Quando um device nao aparece, e
 * aqui que se descobre se o problema e o transporte ou o driver.
 *
 * Varredura e SOMENTE LEITURA: uma varredura que escreve pode reprogramar o
 * SPD das memorias e deixar a maquina sem bootar.
 *
 * Rode ELEVADO para enxergar o SMBus. Uso: npm run probe:buses
 */
import { openBuses, closeBuses, pawnIoModuleDir } from '../src/main/engine/hal/index.js';
import { getPawnIoVersion, isPawnIoInstalled } from '../src/main/engine/hal/pawnio.js';
import { PawnIoSmbus } from '../src/main/engine/hal/smbus.js';

/** Enderecos SMBus conhecidos, para dar significado aos numeros. */
const KNOWN: Record<number, string> = {
  0x15: 'controlador de ventoinha / sensor',
  0x36: 'controlador de bateria / PMBus',
  0x45: 'sensor de tensao',
  0x4a: 'controlador RGB (ASRock/ASUS, variante)',
  0x50: 'SPD do modulo de memoria 1  — NAO ESCREVER',
  0x51: 'SPD do modulo de memoria 2  — NAO ESCREVER',
  0x52: 'SPD do modulo de memoria 3  — NAO ESCREVER',
  0x53: 'SPD do modulo de memoria 4  — NAO ESCREVER',
  0x58: 'RGB de memoria (Kingston Fury / HyperX)',
  0x59: 'RGB de memoria (Kingston Fury / HyperX)',
  0x60: 'RGB de memoria (Corsair)',
  0x63: 'RGB de GPU',
  0x67: 'RGB de memoria (Corsair)',
  0x6a: 'controlador RGB da placa-mae (ASRock Polychrome)',
  0x70: 'RGB de placa-mae (variante)',
};

async function main(): Promise<void> {
  console.log('=== PawnIO ===');
  console.log(`  instalado: ${isPawnIoInstalled() ? 'sim' : 'NAO'}`);
  console.log(`  versao   : ${getPawnIoVersion() ?? '(indisponivel)'}`);
  console.log(`  modulos  : ${pawnIoModuleDir()}`);

  console.log('\n=== abrindo barramentos ===');
  const buses = await openBuses((msg) => console.log(`  ${msg}`));

  if (buses.problems.length > 0) {
    console.log('\n--- problemas ---');
    for (const p of buses.problems) {
      console.log(`  [${p.transport}] ${p.reason}`);
      if (p.hint) console.log(`           ${p.hint}`);
      if (p.needsElevation) console.log('           (resolve com elevacao)');
    }
  }

  console.log(`\n=== SMBus: ${buses.smbus.length} barramento(s) ===`);
  for (const bus of buses.smbus) {
    if (!(bus instanceof PawnIoSmbus)) continue;
    const t0 = Date.now();
    const found = bus.scan();
    const ms = Date.now() - t0;

    console.log(`\n  ${bus.name}  (varredura em ${ms}ms)`);
    if (found.length === 0) {
      console.log('    nenhum device respondeu');
      continue;
    }
    for (const addr of found) {
      const hex = `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;
      console.log(`    ${hex}  ${KNOWN[addr] ?? '(desconhecido)'}`);
    }
  }

  console.log(`\n=== HID ===`);
  if (!buses.hid) {
    console.log('  indisponivel');
  } else {
    const devices = buses.hid.enumerate();
    console.log(`  ${devices.length} device(s) HID no sistema`);
    // So os fabricantes com iluminacao conhecida, senao a lista vira ruido.
    const interesting = devices.filter((d) =>
      [0x046d, 0x1532, 0x1b1c, 0x258a, 0x0b05, 0x1e71, 0x3633].includes(d.vendorId),
    );
    for (const d of interesting) {
      const vid = d.vendorId.toString(16).padStart(4, '0');
      const pid = d.productId.toString(16).padStart(4, '0');
      console.log(
        `    ${vid}:${pid}  if=${d.interfaceNumber}  ` +
          `usage=${d.usagePage ?? '?'}/${d.usage ?? '?'}  ${d.product ?? ''}`,
      );
    }
  }

  console.log(`\n=== I2C de GPU: ${buses.gpu.length} barramento(s) ===`);
  for (const bus of buses.gpu) {
    const found: string[] = [];
    for (const addr of [0x49, 0x50, 0x51, 0x52, 0x60, 0x63, 0x67, 0x68]) {
      if (bus.probe(addr)) found.push(`0x${addr.toString(16).toUpperCase()}`);
    }
    console.log(`  ${bus.name}: ${found.length > 0 ? found.join(', ') : 'nada encontrado'}`);
  }

  closeBuses(buses);
  console.log('\npronto');
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

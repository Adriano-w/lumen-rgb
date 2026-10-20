/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Teste focado nos drivers de SMBus, sem passar pelo detector geral.
 *
 * Existe para isolar: quando algo nao aparece, este script diz se o problema
 * esta no driver do device ou na orquestracao em volta dele.
 *
 * ESCREVE NO HARDWARE. Restaura no `finally`, inclusive se falhar no meio.
 * Rode ELEVADO. Uso: npm run probe:smbus
 */
import { asrockPolychromeDetector } from '../src/main/engine/controllers/asrock-polychrome.js';
import { kingstonFuryDetector } from '../src/main/engine/controllers/kingston-fury.js';
import { openBuses, closeBuses } from '../src/main/engine/hal/index.js';
import { findAutonomousModeIndex } from '../src/main/engine/device-mapper.js';
import type { Controller, DetectionContext } from '../src/main/engine/hal/types.js';
import type { RGB } from '../src/shared/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const buses = await openBuses((m) => console.log(`  ${m}`));

  if (buses.smbus.length === 0) {
    console.error('\nNenhum barramento SMBus. Rode como administrador.');
    for (const p of buses.problems) console.error(`  [${p.transport}] ${p.reason}`);
    process.exitCode = 1;
    return;
  }

  const ctx: DetectionContext = {
    smbus: buses.smbus,
    hid: { enumerate: () => [], open: () => { throw new Error('nao usado'); } },
    gpu: [],
    log: (m) => console.log(`  ${m}`),
  };

  const controllers: Controller[] = [];
  for (const detector of [asrockPolychromeDetector, kingstonFuryDetector]) {
    console.log(`\n=== ${detector.name} ===`);
    try {
      const found = await detector.detect(ctx);
      console.log(`  ${found.length} device(s)`);
      controllers.push(...found);
    } catch (err) {
      console.error(`  FALHOU: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const c of controllers) {
    console.log(`\n--- ${c.name} ---`);
    console.log(`  local=${c.location}  fw=${c.version}  id=${c.id}`);
    console.log(`  LEDs=${c.ledCount}  zonas=${c.zones.length}  modos=${c.modes.length}`);
    console.log(`  desgasta flash ao escrever: ${c.writeWearRisk ? 'SIM' : 'nao'}`);
    for (const z of c.zones) console.log(`    "${z.name}": ${z.type}, ${z.ledCount} LEDs`);
    console.log(`  modos: ${c.modes.map((m) => m.name).join(', ')}`);

    const zoneSum = c.zones.reduce((n, z) => n + z.ledCount, 0);
    if (zoneSum !== c.ledCount) console.log(`  !! zonas somam ${zoneSum}, device diz ${c.ledCount}`);
    if (c.ledNames.length !== c.ledCount) {
      console.log(`  !! ${c.ledNames.length} nomes para ${c.ledCount} LEDs`);
    }

    if (c.directModeIndex === undefined) {
      console.log('  sem modo direto — pulando escrita');
      continue;
    }

    let original = 0;
    try {
      original = c.getActiveMode();
    } catch {
      // alguns controllers nao sabem reportar
    }
    console.log(`  modo ativo antes: ${c.modes[original]?.name ?? original}`);

    try {
      c.setMode(c.directModeIndex, {});
      for (const [label, color] of [
        ['vermelho', { r: 255, g: 0, b: 0 }],
        ['verde', { r: 0, g: 255, b: 0 }],
        ['azul', { r: 0, g: 0, b: 255 }],
      ] as const) {
        const t0 = Date.now();
        const colors: RGB[] = Array.from({ length: c.ledCount }, () => ({ ...color }));
        c.updateLeds(colors);
        console.log(`    ${label}: ${Date.now() - t0}ms para ${c.ledCount} LEDs`);
        await sleep(800);
      }

      // Zona isolada: confirma que o offset por zona esta certo.
      if (c.zones.length > 1) {
        const zone = c.zones[0]!;
        c.updateZoneLeds(0, Array.from({ length: zone.ledCount }, () => ({ r: 255, g: 255, b: 0 })));
        console.log(`    zona "${zone.name}" sozinha em amarelo`);
        await sleep(1200);
      }
    } finally {
      const wasDirect = original === c.directModeIndex;
      const idx = wasDirect ? (findAutonomousModeIndex(c) ?? original) : original;
      const mode = c.modes[idx]!;
      c.setMode(idx, {
        brightness: mode.brightness?.max,
        colors: mode.colorsMin > 0 ? [{ r: 255, g: 255, b: 255 }] : undefined,
      });
      console.log(`  restaurado para "${mode.name}"`);
    }
  }

  for (const c of controllers) c.close();
  closeBuses(buses);
  console.log('\npronto');
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

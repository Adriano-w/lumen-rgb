/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Demonstracao lado a lado: modo de firmware x efeito do Lumen.
 *
 * Existe para tornar visivel uma diferenca que nao da para explicar so no
 * texto. Modos de firmware rodam dentro de cada controlador, cada um com o
 * proprio relogio — nenhum software os alinha. Efeitos do Lumen sao calculados
 * aqui, a partir de uma origem de tempo unica, e chegam em fase.
 *
 * Rode ELEVADO. Uso: npm run demo:sync
 */
import { detectControllers } from '../src/main/engine/detector.js';
import { openBuses, closeBuses } from '../src/main/engine/hal/index.js';
import { findAutonomousModeIndex } from '../src/main/engine/device-mapper.js';
import { EffectRunner, targetKey, type EffectSink } from '../src/main/engine/effects/runner.js';
import type { Controller } from '../src/main/engine/hal/types.js';
import { DEFAULT_EFFECT_PARAMS } from '../src/shared/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const buses = await openBuses(() => undefined);
  const { controllers } = await detectControllers(buses, () => undefined);

  const usable = controllers.filter((c) => c.directModeIndex !== undefined && c.ledCount > 0);
  console.log(`${usable.length} device(s) aceitam efeitos do Lumen:`);
  for (const c of usable) console.log(`  · ${c.name} (${c.ledCount} LEDs)`);

  /* ---- parte 1: modos de firmware ---- */

  console.log('\n========================================');
  console.log(' PARTE 1 — modos de FIRMWARE (20s)');
  console.log('========================================');
  console.log('Cada device roda o ciclo no proprio microcontrolador.');
  console.log('Repare: eles NAO se alinham, e nao ha como alinhar.\n');

  for (const c of controllers) {
    const idx = findAutonomousModeIndex(c);
    if (idx === undefined) continue;
    const mode = c.modes[idx]!;
    c.setMode(idx, { brightness: mode.brightness?.max, speed: mode.speed?.default });
    console.log(`  ${c.name}: "${mode.name}"`);
  }
  await sleep(20000);

  /* ---- parte 2: efeito do Lumen ---- */

  console.log('\n========================================');
  console.log(' PARTE 2 — efeito do LUMEN (25s)');
  console.log('========================================');
  console.log('Agora o app calcula cada pixel, de uma origem de tempo unica.');
  console.log('Repare: todos passam pela mesma cor ao mesmo tempo.\n');

  const byIndex = new Map<number, Controller>();
  usable.forEach((c, i) => byIndex.set(i, c));

  const sink: EffectSink = {
    writeDevice: async (index, colors) => byIndex.get(index)!.updateLeds(colors),
    writeZone: async (index, zone, colors) => byIndex.get(index)!.updateZoneLeds(zone, colors),
  };
  const runner = new EffectRunner(sink, 30, (key, err) =>
    console.error(`  [runner] ${key}: ${err.message}`),
  );

  try {
    usable.forEach((c, i) => {
      c.setMode(c.directModeIndex!, {});
      runner.setEffect(
        {
          key: targetKey(c.id),
          backendIndex: i,
          ledCount: c.ledCount,
          location: c.location,
          transport: c.transport,
          writeWearRisk: c.writeWearRisk,
        },
        // Ciclo de cores: o device inteiro muda junto, entao da para comparar
        // entre devices a olho nu — mais claro que uma onda espacial.
        { kind: 'color-cycle', params: { ...DEFAULT_EFFECT_PARAMS, speed: 35 } },
      );
      console.log(`  ${c.name}: ciclo de cores do Lumen`);
    });

    await sleep(25000);
  } finally {
    runner.clearAll();
    console.log('\ndevolvendo tudo ao firmware ...');
    for (const c of controllers) {
      const idx = findAutonomousModeIndex(c);
      if (idx === undefined) continue;
      try {
        const mode = c.modes[idx]!;
        c.setMode(idx, { brightness: mode.brightness?.max, speed: mode.speed?.default });
      } catch {
        // seguimos para o proximo
      }
    }
    for (const c of controllers) {
      try {
        c.close();
      } catch {
        // seguimos
      }
    }
    closeBuses(buses);
  }

  console.log('pronto');
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

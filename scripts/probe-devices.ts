/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Validacao do backend NATIVO contra hardware real.
 *
 * Nao ha servidor externo: este script abre os barramentos, roda os detectores
 * e fala com o hardware pelos nossos proprios drivers.
 *
 * Precisa rodar ELEVADO para enxergar placa-mae e memoria (SMBus).
 *
 * Uso: npm run probe
 */
import { detectControllers } from '../src/main/engine/detector.js';
import { openBuses, closeBuses } from '../src/main/engine/hal/index.js';
import { findAutonomousModeIndex } from '../src/main/engine/device-mapper.js';
import type { Controller } from '../src/main/engine/hal/types.js';
import type { RGB } from '../src/shared/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function snapshotMode(controller: Controller): number {
  try {
    return controller.getActiveMode();
  } catch {
    return 0;
  }
}

/** Devolve o controller ao firmware, para nao deixar nada congelado. */
function restore(controller: Controller, originalMode: number): string {
  const directIndex = controller.directModeIndex;
  const wasDirect = directIndex !== undefined && originalMode === directIndex;

  // Se o modo original ja era direto, restaura-lo deixaria o device congelado
  // na ultima cor. Preferimos um modo que o firmware execute sozinho.
  const targetIndex = wasDirect ? (findAutonomousModeIndex(controller) ?? originalMode) : originalMode;
  const mode = controller.modes[targetIndex];
  if (!mode) return `${controller.name}: sem modo para restaurar`;

  controller.setMode(targetIndex, {
    brightness: mode.brightness?.max,
    colors: mode.colorsMin > 0 ? [{ r: 255, g: 255, b: 255 }] : undefined,
  });

  return wasDirect && targetIndex !== originalMode
    ? `${controller.name}: modo original era direto (congelaria) — restaurado como "${mode.name}"`
    : `${controller.name}: modo "${mode.name}" restaurado`;
}

async function main(): Promise<void> {
  console.log('abrindo barramentos de hardware ...\n');
  const buses = await openBuses((msg) => console.log(`  ${msg}`));

  if (buses.problems.length > 0) {
    console.log('\nproblemas de transporte:');
    for (const p of buses.problems) {
      console.log(`  [${p.transport}] ${p.reason}${p.hint ? ` — ${p.hint}` : ''}`);
    }
  }

  console.log('\ndetectando devices ...');
  const { controllers, failures } = await detectControllers(buses, (msg) => console.log(`  ${msg}`));

  if (failures.length > 0) {
    console.log('\nfamilias que falharam:');
    for (const f of failures) console.log(`  ${f.family}: ${f.error}`);
  }

  console.log(`\n=== ${controllers.length} device(s) ===\n`);

  let problems = 0;

  for (const [i, c] of controllers.entries()) {
    const zoneLeds = c.zones.reduce((n, z) => n + z.ledCount, 0);
    const direct = c.directModeIndex !== undefined ? c.modes[c.directModeIndex] : undefined;

    console.log(`[${i}] ${c.name}`);
    console.log(`     vendor=${c.vendor}  tipo=${c.type}  fw=${c.version || '-'}`);
    console.log(`     local=${c.location}`);
    console.log(`     id=${c.id}`);
    console.log(`     LEDs=${c.ledCount} (soma das zonas=${zoneLeds})  modos=${c.modes.length}`);
    console.log(`     modo direto=${direct ? `"${direct.name}" (idx ${c.directModeIndex})` : 'NENHUM'}`);

    if (zoneLeds !== c.ledCount) {
      console.log(`     !! soma das zonas (${zoneLeds}) != total de LEDs (${c.ledCount})`);
      problems++;
    }
    if (c.ledNames.length !== c.ledCount) {
      console.log(`     !! ${c.ledNames.length} nomes de LED para ${c.ledCount} LEDs`);
      problems++;
    }

    for (const z of c.zones) {
      const resize = z.ledsMin !== undefined && z.ledsMax !== undefined && z.ledsMax > z.ledsMin
        ? `, redimensionavel ${z.ledsMin}-${z.ledsMax}`
        : '';
      console.log(`       zona "${z.name}": ${z.type}, leds=${z.ledCount}${resize}`);
    }

    console.log(`     modos: ${c.modes.map((m) => m.name).join(', ')}`);
    console.log('');
  }

  /* ---- teste de escrita ---- */
  const target = controllers.find((c) => c.directModeIndex !== undefined && c.ledCount > 0);
  if (!target) {
    console.log('nenhum device aceita escrita direta — pulando teste de escrita');
  } else {
    const original = snapshotMode(target);
    console.log(`teste de escrita em "${target.name}" (${target.ledCount} LEDs)`);

    try {
      target.setMode(target.directModeIndex!, {});
      for (const [label, color] of [
        ['vermelho', { r: 255, g: 0, b: 0 }],
        ['verde', { r: 0, g: 255, b: 0 }],
        ['azul', { r: 0, g: 0, b: 255 }],
      ] as const) {
        const colors: RGB[] = Array.from({ length: target.ledCount }, () => ({ ...color }));
        target.updateLeds(colors);
        console.log(`  pintado de ${label}`);
        await sleep(700);
      }
    } finally {
      console.log(`  ${restore(target, original)}`);
    }
  }

  for (const c of controllers) {
    try {
      c.close();
    } catch {
      // encerrando mesmo assim
    }
  }
  closeBuses(buses);

  console.log(`\n${problems === 0 ? 'OK — nenhum problema detectado' : `${problems} problema(s)`}`);
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

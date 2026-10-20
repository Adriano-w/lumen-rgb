/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Devolve cada device a um modo de FIRMWARE, para que a iluminacao volte a ser
 * autonoma e nao dependa de nenhum software rodando.
 *
 * Isso existe porque modo direto tem um custo escondido: enquanto o device esta
 * nele, quem pinta e o host. Se o host sai de cena, o device congela na ultima
 * cor recebida. Um modo de firmware nao tem esse problema.
 *
 * Tambem e o caminho de resgate quando um efeito interrompido deixou algo preso
 * numa cor.
 *
 * Precisa rodar ELEVADO para alcancar placa-mae e memoria.
 *
 * Uso: npm run restore              (modo preferido por tipo de device)
 *      npm run restore -- Static    (forca um modo pelo nome)
 */
import { detectControllers } from '../src/main/engine/detector.js';
import { openBuses, closeBuses } from '../src/main/engine/hal/index.js';
import type { Controller, ControllerMode } from '../src/main/engine/hal/types.js';
import type { DeviceType } from '../src/shared/types.js';

/**
 * Modo preferido por tipo de device, em ordem de tentativa.
 *
 * A intencao: iluminacao viva e autonoma onde faz sentido, e discreta onde o
 * device normalmente fica apagado.
 */
const PREFERENCE: Partial<Record<DeviceType, readonly string[]>> = {
  motherboard: ['Rainbow', 'Spectrum Cycle', 'Static'],
  dram: ['Rainbow', 'Spectrum', 'Spectrum Cycle', 'Static'],
  gpu: ['Spectrum Cycle', 'Color Cycle', 'Static'],
  mouse: ['Off', 'Static'],
  headset: ['Off', 'Static'],
  keyboard: ['Off', 'Static'],
};

const FALLBACK = ['Off', 'Static'] as const;

function pickMode(controller: Controller, forced?: string): { mode: ControllerMode; index: number } | undefined {
  const wanted = forced ? [forced] : (PREFERENCE[controller.type] ?? FALLBACK);
  for (const name of wanted) {
    const index = controller.modes.findIndex((m) => m.name.toLowerCase() === name.toLowerCase());
    if (index >= 0) return { mode: controller.modes[index]!, index };
  }
  return undefined;
}

async function main(): Promise<void> {
  const forced = process.argv[2];

  const buses = await openBuses(() => undefined);
  const { controllers } = await detectControllers(buses, () => undefined);

  console.log(`${controllers.length} device(s)${forced ? `, forcando modo "${forced}"` : ''}\n`);

  for (const controller of controllers) {
    const picked = pickMode(controller, forced);
    if (!picked) {
      console.log(`  ${controller.name}: nenhum modo adequado — deixando como esta`);
      continue;
    }

    try {
      // Brilho no maximo e cor neutra: um modo restaurado nao pode voltar
      // apagado por herdar brilho 0 ou cor preta e parecer que falhou.
      controller.setMode(picked.index, {
        brightness: picked.mode.brightness?.max,
        colors:
          picked.mode.colorsMin > 0
            ? Array.from({ length: picked.mode.colorsMin }, () => ({ r: 255, g: 255, b: 255 }))
            : undefined,
      });
      console.log(`  ${controller.name}: modo "${picked.mode.name}" aplicado`);
    } catch (err) {
      console.error(
        `  ${controller.name}: FALHOU — ${err instanceof Error ? err.message : String(err)}`,
      );
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

  console.log('\npronto — a iluminacao agora roda sozinha, sem depender do Lumen');
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

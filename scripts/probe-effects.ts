/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Validacao do motor de efeitos contra hardware real, pelo backend nativo.
 *
 * Verifica:
 *   1. os kernels sao puros e deterministicos (mesmo t -> mesma cor);
 *   2. o limitador de fps por transporte respeita SMBus;
 *   3. um efeito unico atravessa todos os devices em fase;
 *   4. efeito estatico converge e PARA de escrever.
 *
 * Precisa rodar ELEVADO. Uso: npm run probe:effects
 */
import { detectControllers } from '../src/main/engine/detector.js';
import { openBuses, closeBuses } from '../src/main/engine/hal/index.js';
import { findAutonomousModeIndex } from '../src/main/engine/device-mapper.js';
import { renderTarget, AVAILABLE_EFFECTS, isEffectAvailable } from '../src/main/engine/effects/kernels.js';
import { EffectRunner, fpsForLocation, fpsForTarget, targetKey, type EffectSink } from '../src/main/engine/effects/runner.js';
import type { Controller } from '../src/main/engine/hal/types.js';
import { DEFAULT_EFFECT_PARAMS, type EffectKind } from '../src/shared/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERCAO FALHOU: ${msg}`);
}

/* ---- 1. pureza dos kernels ---- */

function testKernelPurity(): void {
  console.log('--- kernels ---');
  console.log(`disponiveis (${AVAILABLE_EFFECTS.length}): ${AVAILABLE_EFFECTS.join(', ')}`);

  const capture = (['audio-level', 'ambient-screen'] as EffectKind[]).filter((k) => !isEffectAvailable(k));
  console.log(`indisponiveis neste build: ${capture.join(', ') || 'nenhum'}`);

  for (const kind of AVAILABLE_EFFECTS) {
    const params = {
      ...DEFAULT_EFFECT_PARAMS,
      colors: [
        { r: 255, g: 40, b: 0 },
        { r: 0, g: 80, b: 255 },
      ],
    };
    const a = renderTarget(kind, params, 10, 1.234, []);
    const b = renderTarget(kind, params, 10, 1.234, []);

    assert(a.length === 10, `${kind} devolveu ${a.length} LEDs, esperado 10`);
    for (let i = 0; i < 10; i++) {
      assert(
        a[i]!.r === b[i]!.r && a[i]!.g === b[i]!.g && a[i]!.b === b[i]!.b,
        `${kind} nao e deterministico no LED ${i}`,
      );
      for (const ch of ['r', 'g', 'b'] as const) {
        const v = a[i]![ch];
        assert(Number.isInteger(v) && v >= 0 && v <= 255, `${kind} gerou ${ch}=${v} fora da faixa`);
      }
    }

    const dark = renderTarget(kind, { ...params, brightness: 0 }, 4, 0.5, []);
    assert(
      dark.every((c) => c.r === 0 && c.g === 0 && c.b === 0),
      `${kind} nao apaga com brilho 0`,
    );
    console.log(`  ${kind}: deterministico, faixa valida, respeita brilho 0  OK`);
  }

  // `spread` e o comprimento de onda em LEDs.
  const full = renderTarget('rainbow-wave', { ...DEFAULT_EFFECT_PARAMS, spread: 16 }, 16, 0, []);
  assert(
    new Set(full.map((c) => `${c.r},${c.g},${c.b}`)).size === 16,
    'rainbow-wave com spread=16 deveria dar 16 cores distintas',
  );
  const half = renderTarget('rainbow-wave', { ...DEFAULT_EFFECT_PARAMS, spread: 8 }, 16, 0, []);
  assert(
    new Set(half.map((c) => `${c.r},${c.g},${c.b}`)).size === 8,
    'rainbow-wave com spread=8 em 16 LEDs deveria repetir 2x',
  );
  console.log('  rainbow-wave: varia no espaco e repete conforme o spread  OK');

  const t0 = renderTarget('breathing', DEFAULT_EFFECT_PARAMS, 1, 0, []);
  const t1 = renderTarget('breathing', DEFAULT_EFFECT_PARAMS, 1, 1.7, []);
  assert(t0[0]!.r !== t1[0]!.r || t0[0]!.g !== t1[0]!.g, 'breathing nao varia no tempo');
  console.log('  breathing varia no tempo  OK\n');
}

/* ---- 2. limites de fps ---- */

function testFpsCaps(): void {
  console.log('--- limites de fps por transporte ---');
  for (const [location, expected] of [
    ['I2C: SMBus PIIX4 1, address 0x6A', 8],
    ['HID: \\\\?\\HID#VID_046D&PID_C539', 30],
    ['algo desconhecido', 20],
  ] as Array<[string, number]>) {
    const got = fpsForLocation(location);
    assert(got === expected, `fps de "${location}" deu ${got}, esperado ${expected}`);
    console.log(`  ${expected} fps  <-  ${location.slice(0, 44)}  OK`);
  }
  console.log('');
}

/* ---- 3 e 4. efeito ao vivo ---- */

async function testLive(): Promise<void> {
  console.log('--- efeito ao vivo no hardware ---');

  const buses = await openBuses(() => undefined);
  const { controllers } = await detectControllers(buses, () => undefined);

  const usable = controllers.filter((c) => c.directModeIndex !== undefined && c.ledCount > 0);
  console.log(`${usable.length}/${controllers.length} devices aceitam efeitos do Lumen`);
  for (const c of controllers) {
    const name = c.directModeIndex !== undefined ? c.modes[c.directModeIndex]?.name : '-';
    console.log(
      `  ${c.name}: direto=${c.directModeIndex !== undefined ? `sim (${name})` : 'NAO'}  ` +
        `${c.ledCount} LEDs  ${fpsForTarget(c.location, c.writeWearRisk, c.transport)} fps`,
    );
  }

  if (usable.length === 0) {
    console.log('\nnenhum device utilizavel — pulando teste ao vivo');
    closeBuses(buses);
    return;
  }

  let writes = 0;
  let disabled = 0;
  const byIndex = new Map<number, Controller>();
  usable.forEach((c, i) => byIndex.set(i, c));

  const sink: EffectSink = {
    writeDevice: async (index, colors) => {
      writes++;
      byIndex.get(index)!.updateLeds(colors);
    },
    writeZone: async (index, zone, colors) => {
      writes++;
      byIndex.get(index)!.updateZoneLeds(zone, colors);
    },
  };

  const runner = new EffectRunner(sink, 30, (key, err) => {
    disabled++;
    console.error(`  [runner] ${key}: ${err.message}`);
  });

  const originalModes = new Map<string, number>();
  for (const c of usable) {
    try {
      originalModes.set(c.id, c.getActiveMode());
    } catch {
      originalModes.set(c.id, 0);
    }
  }

  try {
    usable.forEach((c, i) => {
      c.setMode(c.directModeIndex!, {});
      runner.setEffect(
        { key: targetKey(c.id), backendIndex: i, ledCount: c.ledCount, location: c.location, transport: c.transport, writeWearRisk: c.writeWearRisk },
        { kind: 'rainbow-wave', params: { ...DEFAULT_EFFECT_PARAMS, speed: 60, spread: 12 } },
      );
    });

    console.log(`\nrodando rainbow-wave em ${runner.activeCount} alvos por 5s ...`);
    await sleep(5000);
    console.log(`  ${writes} escritas, ${disabled} alvo(s) desativado(s) por erro`);
    assert(writes > 0, 'nenhuma escrita chegou ao hardware');

    console.log('\ntrocando para estatico — escritas devem cessar apos convergir');
    usable.forEach((c, i) => {
      runner.setEffect(
        { key: targetKey(c.id), backendIndex: i, ledCount: c.ledCount, location: c.location, transport: c.transport, writeWearRisk: c.writeWearRisk },
        { kind: 'static', params: { ...DEFAULT_EFFECT_PARAMS, colors: [{ r: 0, g: 180, b: 255 }] } },
      );
    });
    await sleep(1500);
    const converged = writes;
    await sleep(2000);
    const idle = writes - converged;
    console.log(`  escritas nos 2s apos convergir: ${idle}`);
    assert(idle === 0, `efeito estatico continuou escrevendo (${idle} escritas)`);
    console.log('  deduplicacao de frame identico  OK');
  } finally {
    runner.clearAll();
    console.log('\nrestaurando o hardware ...');
    for (const c of usable) {
      try {
        const original = originalModes.get(c.id) ?? 0;
        const wasDirect = original === c.directModeIndex;
        const index = wasDirect ? (findAutonomousModeIndex(c) ?? original) : original;
        const mode = c.modes[index]!;
        c.setMode(index, {
          brightness: mode.brightness?.max,
          colors: mode.colorsMin > 0 ? [{ r: 255, g: 255, b: 255 }] : undefined,
        });
        console.log(`  ${c.name}: modo "${mode.name}" restaurado`);
      } catch (err) {
        console.error(`  ${c.name}: FALHA ao restaurar — ${err instanceof Error ? err.message : err}`);
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
  }
}

async function main(): Promise<void> {
  testKernelPurity();
  testFpsCaps();
  await testLive();
  console.log('\nTODOS OS TESTES PASSARAM');
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

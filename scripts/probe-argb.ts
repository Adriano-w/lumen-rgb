/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Configura e testa o header ARGB da placa-mae.
 *
 * O firmware reporta a CAPACIDADE do header (80 LEDs nesta placa), mas quantos
 * LEDs existem de fato na fita e o que estiver no registrador 0x32 — e isso
 * mora no hardware e sobrevive a reinicios.
 *
 * Uso:
 *   npm run probe:argb              mostra a configuracao atual
 *   npm run probe:argb -- walk      descobre o tamanho real da fita, de olho
 *   npm run probe:argb -- 70        configura 70 LEDs e pinta um teste
 *   npm run probe:argb -- 70 7      configura 70 LEDs em 7 grupos (fans)
 *
 * Rode ELEVADO.
 */
import { asrockPolychromeDetector } from '../src/main/engine/controllers/asrock-polychrome.js';
import { openBuses, closeBuses } from '../src/main/engine/hal/index.js';
import type { Controller, DetectionContext } from '../src/main/engine/hal/types.js';
import type { RGB } from '../src/shared/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Cores bem separadas, para dar para contar os grupos de olho. */
const GROUP_COLORS: readonly RGB[] = [
  { r: 255, g: 0, b: 0 },
  { r: 255, g: 110, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 0, g: 200, b: 255 },
  { r: 0, g: 0, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 255, g: 255, b: 255 },
];

/**
 * Descobre o tamanho real da fita de olho.
 *
 * Acende um LED a mais por vez, anunciando o indice. O usuario observa e anota
 * dois numeros: quando a PRIMEIRA fan fica completa (= LEDs por fan) e quando a
 * ULTIMA fan completa (= total da fita).
 *
 * Isso existe porque nao da para perguntar ao hardware: o firmware reporta a
 * capacidade do header (80), nao o que esta ligado nele. So olhando.
 */
async function walk(board: Controller, argbIndex: number): Promise<void> {
  if (!board.resizeZone) {
    console.error('driver sem suporte a redimensionar');
    return;
  }

  const max = board.zones[argbIndex]!.ledsMax ?? 80;
  console.log(`\nexpandindo a fita para o maximo (${max}) para poder varrer ...`);
  board.resizeZone(argbIndex, max);
  board.setMode(board.directModeIndex!, {});

  const n = board.zones[argbIndex]!.ledCount;
  console.log('\nVou acender um LED a mais por vez, do inicio da fita.');
  console.log('Anote: (1) em que numero a PRIMEIRA fan fica completa;');
  console.log('       (2) em que numero a ULTIMA fan fica completa.\n');

  const off: RGB = { r: 0, g: 0, b: 0 };
  const on: RGB = { r: 255, g: 255, b: 255 };

  for (let lit = 1; lit <= n; lit++) {
    const colors: RGB[] = [];
    for (let i = 0; i < n; i++) colors.push(i < lit ? { ...on } : { ...off });
    board.updateZoneLeds(argbIndex, colors);
    process.stdout.write(`\r  acesos: ${String(lit).padStart(3)} / ${n}   `);
    await sleep(700);
  }

  console.log('\n\nvarredura concluida.');
  console.log('Rode de novo com o total que voce contou, por exemplo:');
  console.log('  npm run probe:argb -- 56 7      (56 LEDs, 7 fans)');

  const rainbow = board.modes.findIndex((m) => m.name === 'Rainbow');
  board.setMode(rainbow, {});
}

async function main(): Promise<void> {
  const wanted = process.argv[2] ? Number(process.argv[2]) : undefined;
  const groups = process.argv[3] ? Number(process.argv[3]) : 0;

  const buses = await openBuses(() => undefined);
  const ctx: DetectionContext = {
    smbus: buses.smbus,
    hid: { enumerate: () => [], open: () => { throw new Error('nao usado'); } },
    gpu: [],
    log: (m) => console.log(`  ${m}`),
  };

  const found = await asrockPolychromeDetector.detect(ctx);
  const board: Controller | undefined = found[0];
  if (!board) {
    console.error('placa-mae nao detectada — rode como administrador');
    closeBuses(buses);
    process.exitCode = 1;
    return;
  }

  const argbIndex = board.zones.findIndex((z) => z.name === 'Addressable Header');
  if (argbIndex < 0) {
    console.error('esta placa nao expoe header enderecavel');
    closeBuses(buses);
    return;
  }

  const zone = board.zones[argbIndex]!;
  console.log(`\nheader ARGB: ${zone.ledCount} LED(s) configurados, maximo ${zone.ledsMax}`);
  console.log(`device inteiro: ${board.ledCount} LEDs em ${board.zones.length} zonas`);

  if (process.argv[2] === 'walk') {
    await walk(board, argbIndex);
    board.close();
    closeBuses(buses);
    return;
  }

  if (wanted === undefined || Number.isNaN(wanted)) {
    console.log('\npasse a contagem desejada para configurar. ex: npm run probe:argb -- 70 7');
    console.log('ou use "walk" para descobrir o tamanho real olhando as fans.');
    board.close();
    closeBuses(buses);
    return;
  }

  if (!board.resizeZone) {
    console.error('este driver nao suporta redimensionar zonas');
    board.close();
    closeBuses(buses);
    return;
  }

  console.log(`\nconfigurando a fita para ${wanted} LEDs ...`);
  board.resizeZone(argbIndex, wanted);

  const after = board.zones[argbIndex]!;
  console.log(`  agora: ${after.ledCount} LED(s)  (device: ${board.ledCount} LEDs)`);

  if (after.ledCount !== wanted) {
    console.log(`  !! pedi ${wanted} mas ficou ${after.ledCount} — limitado pelo firmware`);
  }

  // Modo direto, senao o firmware ignora cor por LED.
  board.setMode(board.directModeIndex!, {});

  const n = after.ledCount;
  const groupCount = groups > 0 ? groups : 1;
  const perGroup = Math.max(1, Math.floor(n / groupCount));

  console.log(
    `\npintando ${n} LEDs em ${groupCount} grupo(s) de ~${perGroup} — OLHE PARA AS FANS`,
  );
  console.log('  se cada fan ficar de uma cor diferente, o enderecamento funciona');

  const t0 = Date.now();
  const colors: RGB[] = [];
  for (let i = 0; i < n; i++) {
    const group = Math.min(groupCount - 1, Math.floor(i / perGroup));
    colors.push({ ...GROUP_COLORS[group % GROUP_COLORS.length]! });
  }
  board.updateZoneLeds(argbIndex, colors);
  const ms = Date.now() - t0;

  console.log(`  ${n} LEDs escritos em ${ms}ms (${(ms / n).toFixed(1)}ms por LED)`);
  console.log(`  taxa maxima sustentavel: ${(1000 / ms).toFixed(1)} quadros por segundo`);

  await sleep(10000);

  console.log('\ndevolvendo ao firmware (Rainbow) ...');
  const rainbow = board.modes.findIndex((m) => m.name === 'Rainbow');
  board.setMode(rainbow, {});

  board.close();
  closeBuses(buses);
  console.log('pronto');
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

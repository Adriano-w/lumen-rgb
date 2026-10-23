/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Um efeito espacial atravessa os devices como uma fita so?
 *
 * Sem isso, aplicar "arco-iris" a varios devices da um resultado incoerente:
 * cada device recomeca o efeito do zero, com contagem e layout proprios. Um
 * mouse de 2 LEDs mostra duas cores quaisquer, a placa-mae mostra o espectro
 * espremido em 24 posicoes espalhadas fisicamente, a memoria mostra outro
 * gradiente. Visualmente nao parece um efeito — parece cada device fazendo
 * uma coisa.
 *
 * Com a fita virtual, o LED 0 de um device continua de onde o ultimo do
 * anterior parou.
 *
 * Nao toca em hardware. Uso: npm run probe:span
 */
import { renderTarget } from '../src/main/engine/effects/kernels.js';
import { DEFAULT_EFFECT_PARAMS, type RGB } from '../src/shared/types.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERCAO FALHOU: ${msg}`);
}

/** Distancia entre duas cores, para medir continuidade. */
function distance(a: RGB, b: RGB): number {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b);
}

const hex = (c: RGB): string =>
  `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

/** Os devices desta maquina, na ordem em que a UI os lista. */
const DEVICES = [
  { name: 'placa-mae', leds: 24 },
  { name: 'memoria', leds: 20 },
  { name: 'GPU', leds: 1 },
  { name: 'mouse', leds: 2 },
  { name: 'headset', leds: 2 },
];

const total = DEVICES.reduce((n, d) => n + d.leds, 0);
const params = { ...DEFAULT_EFFECT_PARAMS, spread: total };
const t = 0;

console.log(`fita virtual: ${total} LEDs em ${DEVICES.length} devices\n`);

/* ---- sem fita virtual: cada device por si ---- */

console.log('--- SEM fita virtual (cada device isolado) ---');
const isolated: RGB[][] = [];
for (const d of DEVICES) {
  const colors = renderTarget('rainbow-wave', params, d.leds, t, []);
  isolated.push(colors);
  console.log(`  ${d.name.padEnd(10)} primeiro=${hex(colors[0]!)}  ultimo=${hex(colors[colors.length - 1]!)}`);
}

// Cada device comeca na MESMA cor, porque cada um pensa ser o LED 0.
const firstColors = isolated.map((c) => c[0]!);
const allSameStart = firstColors.every((c) => distance(c, firstColors[0]!) === 0);
console.log(`  todos comecam na mesma cor: ${allSameStart ? 'SIM — e o problema' : 'nao'}`);

/* ---- com fita virtual ---- */

console.log('\n--- COM fita virtual (um efeito atravessando tudo) ---');
const spanned: RGB[][] = [];
let offset = 0;
for (const d of DEVICES) {
  const colors = renderTarget('rainbow-wave', params, d.leds, t, [], { offset, total });
  spanned.push(colors);
  console.log(
    `  ${d.name.padEnd(10)} LEDs ${String(offset).padStart(3)}-${String(offset + d.leds - 1).padStart(3)}  ` +
      `primeiro=${hex(colors[0]!)}  ultimo=${hex(colors[colors.length - 1]!)}`,
  );
  offset += d.leds;
}

/* ---- as emendas sao continuas? ---- */

console.log('\n--- continuidade nas emendas entre devices ---');
let worstSeam = 0;
for (let i = 0; i + 1 < spanned.length; i++) {
  const endOfThis = spanned[i]![spanned[i]!.length - 1]!;
  const startOfNext = spanned[i + 1]![0]!;
  const seam = distance(endOfThis, startOfNext);
  worstSeam = Math.max(worstSeam, seam);
  console.log(
    `  ${DEVICES[i]!.name} -> ${DEVICES[i + 1]!.name}: ${hex(endOfThis)} -> ${hex(startOfNext)}  (salto ${seam})`,
  );
}

// Um LED adjacente numa fita de 49 posicoes muda pouco; um salto grande
// significaria que o efeito reiniciou.
const stepWithinDevice = distance(spanned[0]![0]!, spanned[0]![1]!);
console.log(`\n  salto entre LEDs VIZINHOS dentro de um device: ${stepWithinDevice}`);
console.log(`  maior salto numa EMENDA entre devices:        ${worstSeam}`);

assert(
  worstSeam <= stepWithinDevice * 3,
  `emenda descontinua (${worstSeam}) — o efeito esta reiniciando em cada device`,
);
console.log('  emendas continuas: o efeito atravessa os devices  OK');

/* ---- e os devices NAO comecam todos na mesma cor ---- */

const spannedFirst = spanned.map((c) => c[0]!);
const distinct = new Set(spannedFirst.map(hex)).size;
console.log(`\n  devices comecando em cores distintas: ${distinct}/${DEVICES.length}`);
assert(distinct > 1, 'todos os devices ainda comecam na mesma cor');

console.log('\nTODOS OS TESTES PASSARAM');

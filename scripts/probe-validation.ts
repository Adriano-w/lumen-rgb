/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Todo efeito do catalogo sobrevive a fronteira do IPC?
 *
 * Este teste existe por causa de um bug concreto: o validador do IPC tinha uma
 * copia manual da lista de efeitos, congelada nos sete originais enquanto o
 * catalogo crescia para quinze. Oito efeitos eram recusados com "atribuicao
 * invalida" ANTES de chegar ao hardware — da interface, escolher "Chama" na
 * memoria simplesmente dava erro, sem explicacao util.
 *
 * O tipo nao pegou porque `readonly EffectKind[]` aceita um subconjunto: uma
 * lista incompleta continua valida para o compilador. So um teste que percorre
 * o catalogo inteiro fecha essa porta.
 *
 * Nao toca em hardware. Uso: npm run probe:validation
 */
import { sanitizeAssignment } from '../src/main/validation.js';
import { isEffectAvailable } from '../src/main/engine/effects/kernels.js';
import {
  DEFAULT_EFFECT_PARAMS,
  EFFECT_DESCRIPTORS,
  type Assignment,
} from '../src/shared/types.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERCAO FALHOU: ${msg}`);
}

let failures = 0;

console.log(`--- ${EFFECT_DESCRIPTORS.length} efeitos no catalogo ---\n`);

for (const descriptor of EFFECT_DESCRIPTORS) {
  // Exatamente o que a interface envia ao aplicar um efeito.
  const assignment: Assignment = {
    mode: 'lumen',
    effect: { kind: descriptor.kind, params: { ...DEFAULT_EFFECT_PARAMS } },
  };

  const result = sanitizeAssignment(assignment);
  const ok = result !== null && result.mode === 'lumen' && result.effect.kind === descriptor.kind;

  if (!ok) failures++;
  console.log(
    `  ${ok ? 'OK  ' : 'FALHA'}  ${descriptor.kind.padEnd(16)} "${descriptor.label}"`,
  );
}

console.log('');
assert(
  failures === 0,
  `${failures} efeito(s) do catalogo sao recusados pelo validador do IPC. ` +
    'A lista em store.ts divergiu do catalogo em shared/types.ts.',
);
console.log('todos os efeitos do catalogo atravessam o IPC  OK');

/* ---- o validador ainda rejeita o que deve rejeitar ---- */

console.log('\n--- entradas invalidas continuam sendo recusadas ---');

const rejects: Array<[string, unknown]> = [
  ['efeito inexistente', { mode: 'lumen', effect: { kind: 'nao-existe', params: {} } }],
  ['sem modo', { effect: { kind: 'static' } }],
  ['modo desconhecido', { mode: 'telepatia', effect: { kind: 'static' } }],
  ['hardware sem indice', { mode: 'hardware', colors: [] }],
  ['hardware com indice negativo', { mode: 'hardware', modeIndex: -1, colors: [] }],
  ['nao e objeto', 'static'],
  ['nulo', null],
];

for (const [nome, value] of rejects) {
  const result = sanitizeAssignment(value);
  const rejected = result === null;
  console.log(`  ${rejected ? 'OK  ' : 'FALHA'}  recusa ${nome}`);
  assert(rejected, `o validador aceitou algo invalido: ${nome}`);
}

/* ---- modo de hardware passa ---- */

/* ---- catalogo e motor concordam sobre o que roda? ---- */

console.log('\n--- disponibilidade: catalogo x motor ---');
console.log('  a interface decide pelo `requiresCapture` do catalogo;');
console.log('  o motor decide pelo registro de kernels. Precisam concordar.\n');

for (const descriptor of EFFECT_DESCRIPTORS) {
  const engineSaysAvailable = isEffectAvailable(descriptor.kind);
  const catalogSaysAvailable = !descriptor.requiresCapture;
  const agree = engineSaysAvailable === catalogSaysAvailable;

  if (!agree) failures++;
  console.log(
    `  ${agree ? 'OK  ' : 'FALHA'}  ${descriptor.kind.padEnd(16)} ` +
      `catalogo=${catalogSaysAvailable ? 'roda' : 'em breve'}  ` +
      `motor=${engineSaysAvailable ? 'roda' : 'sem kernel'}`,
  );
}

assert(
  failures === 0,
  'catalogo e motor discordam sobre quais efeitos rodam. A interface vai ' +
    'oferecer um efeito que o motor recusa, ou esconder um que funciona.',
);
console.log('\n  catalogo e motor concordam  OK');

console.log('\n--- modo de firmware ---');
const hardware = sanitizeAssignment({
  mode: 'hardware',
  modeIndex: 3,
  colors: [{ r: 255, g: 0, b: 0 }],
  speed: 50,
  brightness: 80,
});
assert(hardware !== null && hardware.mode === 'hardware', 'modo de hardware valido foi recusado');
console.log('  OK    atribuicao de modo de firmware atravessa');

console.log('\nTODOS OS TESTES PASSARAM');

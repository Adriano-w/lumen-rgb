/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * O diagnostico aponta o problema CERTO em cada situacao?
 *
 * Este teste existe por causa de um conselho errado em laco. `backendElevated`
 * era derivado de "o SMBus abriu", entao num PC sem o driver PawnIO o app
 * dizia "sem permissao de administrador" e pedia para reiniciar elevado. O
 * usuario reiniciava, o driver continuava faltando, o SMBus continuava
 * fechado, e a mesma mensagem reaparecia. Nada no app indicava o passo real.
 *
 * Privilegio e disponibilidade de barramento sao perguntas diferentes, e cada
 * combinacao delas tem uma unica acao correta.
 *
 * Nao toca em hardware. Uso: npm run probe:diagnostics
 */
import type { Diagnostics } from '../src/shared/types.js';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERCAO FALHOU: ${msg}`);
}

/**
 * Mesma arvore de decisao do `DiagnosticsBanner`.
 *
 * Duplicar a logica num teste nao e ideal, mas o componente e React e este
 * script roda em Node puro. O que importa verificar aqui e a REGRA — qual
 * problema ganha em cada combinacao — e ela e curta o bastante para espelhar.
 */
function primaryIssue(d: Diagnostics): string {
  if (!d.pawnIoInstalled) return 'pawnio';
  if (!d.backendElevated) return 'elevation';
  if (!d.smbusAvailable) return 'smbus';
  return 'nenhum';
}

const base: Diagnostics = {
  pawnIoInstalled: true,
  backendElevated: true,
  smbusAvailable: true,
  conflictingProcesses: [],
  failedInterfaces: [],
};

const cases: Array<{ nome: string; d: Diagnostics; esperado: string }> = [
  {
    nome: 'PC novo: sem driver, sem privilegio',
    d: { ...base, pawnIoInstalled: false, backendElevated: false, smbusAvailable: false },
    // Mandar elevar aqui e o bug original: elevar nao instala driver nenhum.
    esperado: 'pawnio',
  },
  {
    nome: 'PC novo, ja aberto como admin: sem driver',
    d: { ...base, pawnIoInstalled: false, backendElevated: true, smbusAvailable: false },
    esperado: 'pawnio',
  },
  {
    nome: 'driver instalado, aberto sem privilegio',
    d: { ...base, backendElevated: false, smbusAvailable: false },
    esperado: 'elevation',
  },
  {
    nome: 'driver instalado e elevado, mas o barramento nao abriu',
    d: { ...base, smbusAvailable: false },
    esperado: 'smbus',
  },
  {
    nome: 'tudo certo',
    d: base,
    esperado: 'nenhum',
  },
];

console.log('--- qual problema o app aponta em cada situacao ---\n');

let failures = 0;
for (const c of cases) {
  const got = primaryIssue(c.d);
  const ok = got === c.esperado;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'OK  ' : 'FALHA'}  ${c.nome.padEnd(46)} -> ${got}` +
      (ok ? '' : `  (esperado ${c.esperado})`),
  );
}

console.log('');
assert(failures === 0, `${failures} situacao(oes) apontam o problema errado`);

/* ---- a regressao especifica, nomeada ---- */

const freshPc: Diagnostics = {
  ...base,
  pawnIoInstalled: false,
  backendElevated: false,
  smbusAvailable: false,
};
assert(
  primaryIssue(freshPc) !== 'elevation',
  'num PC sem o driver, o app nao pode pedir elevacao: elevar nao instala driver, ' +
    'e a mensagem nunca mudaria por mais que o usuario reabrisse como administrador',
);
console.log('  num PC sem driver, o app NAO pede elevacao  OK');

// E, crucialmente, elevar de verdade precisa mudar o que o app reporta.
const elevatedNoDriver: Diagnostics = { ...freshPc, backendElevated: true };
assert(
  primaryIssue(elevatedNoDriver) === 'pawnio',
  'depois de elevar, o app deve seguir apontando o driver — nao repetir o pedido de elevacao',
);
console.log('  depois de elevar, o app segue apontando o driver  OK');

console.log('\nTODOS OS TESTES PASSARAM');

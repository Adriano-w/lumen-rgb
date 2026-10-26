/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * O processo atual tem privilegio de administrador?
 *
 * Modulo proprio, **sem dependencia do Electron**, porque a resposta e
 * necessaria tambem dentro do worker de hardware — que nao tem `app`.
 *
 * Isto ja foi deduzido de outro jeito, e o jeito estava errado: o diagnostico
 * reportava "sem privilegio" sempre que o SMBus nao abria, qualquer que fosse
 * o motivo. Num PC sem o driver PawnIO, a interface pedia para reiniciar como
 * administrador; o usuario reiniciava, o driver continuava faltando, e a
 * mensagem nao mudava. Conselho errado, em laco.
 *
 * Privilegio e disponibilidade de barramento sao perguntas diferentes e
 * precisam de respostas diferentes.
 */

let cached: boolean | null = null;

export function isElevated(): boolean {
  if (cached !== null) return cached;

  try {
    // `IsUserAnAdmin` e a checagem canonica e nao tem efeito colateral.
    // Tentar abrir um recurso privilegiado tambem funcionaria, mas sujaria o
    // log de auditoria do sistema.
    const koffi = require('koffi') as typeof import('koffi');
    const shell32 = koffi.load('shell32.dll');
    const IsUserAnAdmin = shell32.func('int __stdcall IsUserAnAdmin()') as () => number;
    cached = IsUserAnAdmin() !== 0;
  } catch {
    // Sem resposta confiavel, assumir "nao elevado" e o lado seguro: a
    // interface oferece elevar, em vez de prometer acesso que nao existe.
    cached = false;
  }

  return cached;
}

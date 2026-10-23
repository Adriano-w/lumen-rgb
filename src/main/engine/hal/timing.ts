/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Pausas sincronas curtas, com a precisao que o hardware exige.
 *
 * Controladores RGB pedem alguns milissegundos entre transacoes, e a interface
 * `Controller` e sincrona — nao da para `await`.
 *
 * O problema: `Atomics.wait` dorme com a granularidade do temporizador do
 * sistema, que no Windows e ~15,6ms. Pedir 1ms custa 15; pedir 10 custa 15.
 * Parece detalhe, mas um driver que pausa 30 vezes por quadro paga 470ms em
 * vez de 300 — e isso ja foi, medido, a diferenca entre a interface responder
 * e travar.
 *
 * Abaixo de um limiar, girar e mais barato que dormir quinze vezes mais do que
 * o pedido. Acima dele, dormir de verdade evita queimar CPU a toa.
 */

const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4));

/**
 * Acima deste valor, a imprecisao do temporizador deixa de importar frente ao
 * custo de ocupar o processador.
 */
const SPIN_THRESHOLD_MS = 20;

export function sleepSync(ms: number): void {
  if (ms <= 0) return;

  if (ms <= SPIN_THRESHOLD_MS) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
      // espera ativa deliberada: ver o comentario do modulo
    }
    return;
  }

  Atomics.wait(SLEEP_SLOT, 0, 0, ms);
}

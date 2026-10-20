/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Deteccao e estavel entre execucoes?
 *
 * O SMBus e compartilhado e falha de forma intermitente. Uma unica deteccao
 * bem-sucedida nao prova nada: ja vimos a memoria aparecer com dois modulos
 * numa execucao e um na seguinte. Este script roda a deteccao varias vezes e
 * compara, porque "funcionou uma vez" e exatamente o tipo de evidencia que
 * esconde esse defeito.
 *
 * Somente leitura — nao muda cor nem modo de nada.
 *
 * Rode ELEVADO. Uso: npm run probe:stability
 */
import { detectControllers } from '../src/main/engine/detector.js';
import { openBuses, closeBuses } from '../src/main/engine/hal/index.js';

const ROUNDS = 5;

async function main(): Promise<void> {
  const buses = await openBuses(() => undefined);
  if (buses.smbus.length === 0) {
    console.error('sem SMBus — rode como administrador');
    closeBuses(buses);
    process.exitCode = 1;
    return;
  }

  /** Assinatura de uma rodada: o que foi achado, de forma comparavel. */
  const signatures: string[] = [];

  for (let round = 1; round <= ROUNDS; round++) {
    const { controllers } = await detectControllers(buses, () => undefined);

    const lines = controllers
      .map((c) => `${c.name} [${c.ledCount} LEDs] @ ${c.location}`)
      .sort();
    signatures.push(lines.join('\n'));

    console.log(`rodada ${round}: ${controllers.length} device(s)`);
    for (const line of lines) console.log(`    ${line}`);

    for (const c of controllers) {
      try {
        c.close();
      } catch {
        // seguimos
      }
    }
  }

  closeBuses(buses);

  const unique = new Set(signatures);
  console.log(`\n${unique.size === 1 ? 'ESTAVEL' : 'INSTAVEL'}: ${unique.size} resultado(s) distinto(s) em ${ROUNDS} rodadas`);

  if (unique.size > 1) {
    console.log('\nvariacoes observadas:');
    for (const [i, sig] of [...unique].entries()) {
      const count = signatures.filter((s) => s === sig).length;
      console.log(`\n  variante ${i + 1} (${count}x):`);
      for (const line of sig.split('\n')) console.log(`    ${line}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});

/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Os efeitos do Lumen ficam mesmo em fase entre devices?
 *
 * Esta e a promessa central do produto, e ela tinha um defeito real: cada alvo
 * guardava a propria origem de tempo, definida no instante em que entrou. Como
 * aplicar um efeito a cinco devices sao cinco chamadas sequenciais e uma
 * escrita SMBus leva centenas de milissegundos, o ultimo device comecava quase
 * um segundo depois do primeiro — e o arco-iris saia rasgado.
 *
 * Aqui medimos de verdade: dois alvos registrados com um atraso grande entre
 * eles devem renderizar a MESMA cor no mesmo instante.
 *
 * Nao toca em hardware — usa um sink falso. Roda sem elevacao.
 *
 * Uso: npm run probe:sync
 */
import { EffectRunner, targetKey, type EffectSink } from '../src/main/engine/effects/runner.js';
import { DEFAULT_EFFECT_PARAMS, type RGB } from '../src/shared/types.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERCAO FALHOU: ${msg}`);
}

async function main(): Promise<void> {
  /** Ultimo quadro que cada alvo recebeu. */
  const frames = new Map<number, RGB[]>();

  const sink: EffectSink = {
    writeDevice: async (index, colors) => {
      frames.set(index, colors.map((c) => ({ ...c })));
    },
    writeZone: async (index, _zone, colors) => {
      frames.set(index, colors.map((c) => ({ ...c })));
    },
  };

  const runner = new EffectRunner(sink, 30, (key, err) => {
    console.error(`  [runner] ${key}: ${err.message}`);
  });

  const effect = {
    kind: 'rainbow-wave' as const,
    params: { ...DEFAULT_EFFECT_PARAMS, speed: 60, spread: 10 },
  };

  console.log('--- fase compartilhada entre alvos ---');
  console.log('registrando o alvo A ...');
  runner.setEffect(
    { key: targetKey('device-a'), backendIndex: 0, ledCount: 10, location: 'HID: a', transport: 'hid' },
    effect,
  );

  // Atraso deliberadamente grande: e o pior caso do bug que existia.
  const delayMs = 1500;
  console.log(`esperando ${delayMs}ms antes de registrar o alvo B ...`);
  await sleep(delayMs);

  console.log('registrando o alvo B ...');
  runner.setEffect(
    { key: targetKey('device-b'), backendIndex: 1, ledCount: 10, location: 'HID: b', transport: 'hid' },
    effect,
  );

  await sleep(400);

  const a = frames.get(0);
  const b = frames.get(1);
  assert(a !== undefined && b !== undefined, 'ambos os alvos deveriam ter recebido quadro');

  let maxDiff = 0;
  for (let i = 0; i < 10; i++) {
    const ca = a![i]!;
    const cb = b![i]!;
    maxDiff = Math.max(
      maxDiff,
      Math.abs(ca.r - cb.r),
      Math.abs(ca.g - cb.g),
      Math.abs(ca.b - cb.b),
    );
  }

  console.log(`\n  alvo A, LED 0: rgb(${a![0]!.r}, ${a![0]!.g}, ${a![0]!.b})`);
  console.log(`  alvo B, LED 0: rgb(${b![0]!.r}, ${b![0]!.g}, ${b![0]!.b})`);
  console.log(`  maior diferenca entre os dois, em qualquer canal: ${maxDiff}`);

  // Tolerancia pequena: os quadros sao capturados em ticks proximos mas nao
  // identicos, entao alguns pontos de diferenca sao esperados num efeito em
  // movimento. Dessincronizado de verdade daria dezenas ou centenas.
  assert(
    maxDiff <= 24,
    `alvos fora de fase: diferenca de ${maxDiff}. Um atraso de ${delayMs}ms no registro ` +
      'nao pode mudar a cor renderizada — a origem de tempo e compartilhada.',
  );
  console.log('\n  alvos EM FASE apesar de 1,5s de diferenca no registro  OK');

  /* ---- um alvo que entra depois nao reinicia o efeito ---- */
  console.log('\n--- um alvo novo entra na fase corrente, nao do zero ---');
  await sleep(600);
  runner.setEffect(
    { key: targetKey('device-c'), backendIndex: 2, ledCount: 10, location: 'HID: c', transport: 'hid' },
    effect,
  );
  await sleep(200);

  const c = frames.get(2);
  const aNow = frames.get(0);
  assert(c !== undefined && aNow !== undefined, 'alvo C deveria ter recebido quadro');

  let diffC = 0;
  for (let i = 0; i < 10; i++) {
    diffC = Math.max(
      diffC,
      Math.abs(c![i]!.r - aNow![i]!.r),
      Math.abs(c![i]!.g - aNow![i]!.g),
      Math.abs(c![i]!.b - aNow![i]!.b),
    );
  }
  console.log(`  diferenca entre o alvo novo e os antigos: ${diffC}`);
  assert(diffC <= 24, `alvo novo comecou do zero em vez de entrar na fase (diferenca ${diffC})`);
  console.log('  alvo novo entrou na fase corrente  OK');

  runner.clearAll();
  console.log('\nTODOS OS TESTES PASSARAM');
}

main().catch((err: unknown) => {
  console.error('\nFALHOU:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

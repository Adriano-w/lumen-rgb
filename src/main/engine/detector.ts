/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Deteccao de hardware.
 *
 * Cada familia de protocolo registra um `ControllerDetector`. Este modulo roda
 * todos contra os barramentos abertos e junta o resultado.
 *
 * Duas decisoes de projeto:
 *
 *  - **Um driver quebrado nao derruba a deteccao.** Cada detector roda isolado;
 *    se lancar, registra-se o erro e passa-se ao proximo. Com dezenas de
 *    familias, um unico device estranho nao pode cegar o app inteiro.
 *
 *  - **Carregamento tardio.** Os drivers entram por `import()` dinamico, entao
 *    um modulo que falhe ao carregar (FFI indisponivel, por exemplo) tambem
 *    degrada sozinho.
 */
import type { BusSet } from './hal/index.js';
import type { Controller, ControllerDetector, DetectionContext, HidBus } from './hal/types.js';

export interface DetectionResult {
  controllers: Controller[];
  /** Familias que falharam, para o diagnostico. */
  failures: Array<{ family: string; error: string }>;
}

/** HID nulo, para quando o transporte nao abriu. */
const NO_HID: HidBus = {
  enumerate: () => [],
  open: () => {
    throw new Error('HID indisponivel');
  },
};

/**
 * Carrega os detectores disponiveis.
 *
 * Adicionar suporte a uma familia nova e acrescentar uma linha aqui e um
 * arquivo em `controllers/`.
 */
async function loadDetectors(
  log: (msg: string) => void,
): Promise<{ detectors: ControllerDetector[]; failures: Array<{ family: string; error: string }> }> {
  const detectors: ControllerDetector[] = [];
  const failures: Array<{ family: string; error: string }> = [];

  const modules: Array<{ family: string; load: () => Promise<{ default?: unknown } & Record<string, unknown>> }> = [
    { family: 'ASRock Polychrome', load: () => import('./controllers/asrock-polychrome.js') },
    { family: 'Kingston Fury', load: () => import('./controllers/kingston-fury.js') },
    { family: 'Logitech HID++', load: () => import('./controllers/logitech-hidpp.js') },
    { family: 'NVIDIA GPU', load: () => import('./controllers/nvidia-gpu.js') },
  ];

  for (const { family, load } of modules) {
    try {
      const mod = await load();
      // Um modulo pode exportar mais de um detector; pegamos todos os que
      // tiverem o formato certo, sem depender do nome da exportacao.
      for (const value of Object.values(mod)) {
        if (isDetector(value)) detectors.push(value);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ family, error: message });
      log(`driver "${family}" nao carregou: ${message}`);
    }
  }

  return { detectors, failures };
}

function isDetector(value: unknown): value is ControllerDetector {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ControllerDetector).name === 'string' &&
    typeof (value as ControllerDetector).detect === 'function'
  );
}

export async function detectControllers(
  buses: BusSet,
  log: (msg: string) => void,
): Promise<DetectionResult> {
  const { detectors, failures } = await loadDetectors(log);

  const ctx: DetectionContext = {
    smbus: buses.smbus,
    hid: buses.hid ?? NO_HID,
    gpu: buses.gpu,
    log,
  };

  const controllers: Controller[] = [];
  const seen = new Set<string>();

  for (const detector of detectors) {
    try {
      const found = await detector.detect(ctx);
      for (const controller of found) {
        // Dois detectores podem reivindicar o mesmo hardware (um generico e um
        // especifico). O primeiro a chegar fica; o segundo e descartado para
        // nao duplicar o device na UI.
        if (seen.has(controller.id)) {
          log(`device duplicado ignorado: ${controller.name} (${controller.id})`);
          controller.close();
          continue;
        }
        seen.add(controller.id);
        controllers.push(controller);
        log(`detectado: ${controller.name} em ${controller.location}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ family: detector.name, error: message });
      log(`deteccao de "${detector.name}" falhou: ${message}`);
    }
  }

  return { controllers, failures };
}

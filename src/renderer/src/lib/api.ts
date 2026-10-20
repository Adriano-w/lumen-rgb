/**
 * Ponto unico de acesso ao backend.
 *
 * Em producao, a ponte do preload expoe `window.lumen`. Fora do Electron
 * (ou antes da ponte existir) caimos num mock com hardware ficticio, para
 * a UI continuar desenvolvivel e verificavel.
 */

import type { LumenApi } from '@shared/types';
import { createMockApi } from './mock-api';

interface LumenWindow {
  lumen?: LumenApi;
}

const bridge = (globalThis as unknown as LumenWindow).lumen;

/** True quando estamos falando com o backend de verdade. */
export const isLiveBackend = Boolean(bridge);

/** True quando a UI esta rodando contra o mock. */
export const isMockBackend = !isLiveBackend;

export const api: LumenApi = bridge ?? createMockApi();

if (isMockBackend) {
  // Deixa explicito no console que nada disso e hardware de verdade.
  console.info(
    '[Lumen] window.lumen nao encontrado — usando backend simulado com devices ficticios.',
  );
}

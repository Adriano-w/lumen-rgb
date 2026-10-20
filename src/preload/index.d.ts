/**
 * Tipagem global da ponte exposta pelo preload.
 * O renderer so precisa de `window.lumen`.
 */
import type { LumenApi } from '../shared/types.js';

declare global {
  interface Window {
    readonly lumen: LumenApi;
  }
}

export {};

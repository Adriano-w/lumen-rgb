/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Mensagens entre o processo principal e o worker de hardware.
 *
 * O worker existe porque falar com RGB e sincrono e lento: uma transacao SMBus
 * leva milissegundos e um quadro completo passa de 300ms. Na thread principal
 * isso congela a interface — literalmente, foi o sintoma relatado.
 *
 * O worker possui os barramentos, os controllers e o motor de efeitos. O
 * processo principal mantem janela, bandeja, IPC e perfis, e conversa por
 * mensagens.
 */
import type { Assignment, Device, Diagnostics, RGB, TargetRef } from '../../../shared/types.js';

/* ------------------------------------------------------------------ *
 * Principal -> worker                                                *
 * ------------------------------------------------------------------ */

export type WorkerCommand =
  | { id: number; kind: 'start'; options: WorkerStartOptions }
  | { id: number; kind: 'stop' }
  | { id: number; kind: 'rescan' }
  | { id: number; kind: 'listDevices' }
  | { id: number; kind: 'getDiagnostics' }
  | { id: number; kind: 'apply'; target: TargetRef; assignment: Assignment }
  | { id: number; kind: 'applyAll'; assignment: Assignment }
  | { id: number; kind: 'applyMany'; deviceIds: readonly string[]; assignment: Assignment }
  | { id: number; kind: 'resizeZone'; deviceId: string; zoneIndex: number; ledsCount: number }
  | { id: number; kind: 'setEffectFps'; fps: number };

/**
 * Um comando sem o `id`, que a fachada atribui.
 *
 * `Omit` direto nao serve: sobre uma uniao ele colapsa para as propriedades
 * COMUNS a todos os membros, e os campos de cada comando somem. A forma
 * condicional distribui sobre a uniao e preserva cada variante.
 */
export type WorkerRequest = WorkerCommand extends infer C
  ? C extends { id: number }
    ? Omit<C, 'id'>
    : never
  : never;

export interface WorkerStartOptions {
  effectFps?: number;
  stopConflictingSoftware?: boolean;
  disableConflictingAutostart?: boolean;
  /** Caminho dos modulos `.bin` do PawnIO, resolvido pelo processo principal. */
  pawnIoModuleDir?: string;
}

/* ------------------------------------------------------------------ *
 * Worker -> principal                                                *
 * ------------------------------------------------------------------ */

export type WorkerEvent =
  /** Resposta a um comando. `id` casa com o da requisicao. */
  | { kind: 'result'; id: number; ok: true; value: unknown }
  | { kind: 'result'; id: number; ok: false; error: string }
  /** A lista de devices mudou (deteccao, redeteccao, hotplug). */
  | { kind: 'devicesChanged'; devices: Device[] }
  | { kind: 'diagnosticsChanged'; diagnostics: Diagnostics }
  /** Linha de log, para o processo principal registrar com o resto. */
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string };

/** Resultado de uma aplicacao em lote: o que deu certo e o que nao deu. */
export interface ApplyManyResult {
  applied: string[];
  failed: Array<{ deviceId: string; error: string }>;
}

/** Cores no fio: array plano de bytes, para nao copiar objetos por LED. */
export function packColors(colors: readonly RGB[]): Uint8Array {
  const out = new Uint8Array(colors.length * 3);
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i]!;
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  return out;
}

export function unpackColors(bytes: Uint8Array): RGB[] {
  const out: RGB[] = [];
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    out.push({ r: bytes[i]!, g: bytes[i + 1]!, b: bytes[i + 2]! });
  }
  return out;
}

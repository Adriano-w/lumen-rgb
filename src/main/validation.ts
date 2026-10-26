/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Saneamento de tudo que cruza uma fronteira.
 *
 * Duas fronteiras usam estes validadores: o IPC (o renderer nunca e tratado
 * como fonte confiavel, mesmo sendo codigo nosso) e o disco (um perfil
 * corrompido ou escrito a mao por um usuario curioso nao pode derrubar o boot).
 *
 * **Sem dependencia do Electron, de proposito.** Estas sao funcoes puras, e
 * manter o modulo livre de `electron` permite exercita-las num teste comum
 * (`npm run probe:validation`). Isso nao e preciosismo: a lista de efeitos
 * aceitos ja divergiu do catalogo em silencio, e oito efeitos eram recusados
 * no IPC sem que nada acusasse. Um teste que percorre o catalogo inteiro
 * fecha essa porta, e ele so e possivel se o modulo rodar fora do Electron.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_EFFECT_PARAMS,
  DEFAULT_SETTINGS,
  EFFECT_DESCRIPTORS,
  type Assignment,
  type EffectKind,
  type EffectParams,
  type EffectSpec,
  type Profile,
  type ProfileEntry,
  type RGB,
  type Settings,
  type TargetRef,
} from '../shared/types.js';
/**
 * Para onde vai um aviso de dado descartado.
 *
 * Injetado em vez de importado: ligar o logger aqui traria `electron` junto
 * e tiraria deste modulo a propriedade que o torna testavel.
 */
export type WarnFn = (message: string) => void;

let warn: WarnFn = () => undefined;

/** O processo principal liga o logger real na inicializacao. */
export function setValidationWarn(fn: WarnFn): void {
  warn = fn;
}

/* ------------------------------------------------------------------ *
 * Validadores primitivos                                             *
 * ------------------------------------------------------------------ */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

const clampByte = (value: unknown, fallback = 0): number =>
  isFiniteNumber(value) ? clamp(Math.round(value), 0, 255) : fallback;

/** Normaliza uma cor vinda de qualquer lugar (arquivo, renderer, perfil antigo). */
export function sanitizeRgb(value: unknown): RGB | null {
  if (!isRecord(value)) return null;
  if (!isFiniteNumber(value.r) || !isFiniteNumber(value.g) || !isFiniteNumber(value.b)) return null;
  return { r: clampByte(value.r), g: clampByte(value.g), b: clampByte(value.b) };
}

/** Lista de cores saneada. Entradas invalidas sao descartadas. */
export function sanitizeRgbList(value: unknown): RGB[] {
  if (!Array.isArray(value)) return [];
  const out: RGB[] = [];
  // Teto defensivo: um device real nunca passa de alguns milhares de LEDs.
  for (const raw of value.slice(0, 4096)) {
    const color = sanitizeRgb(raw);
    if (color) out.push(color);
  }
  return out;
}

/**
 * Efeitos aceitos na fronteira do IPC.
 *
 * DERIVADO do catalogo, nunca escrito a mao. Isto ja foi uma lista literal, e
 * ela silenciosamente parou no conjunto original de sete enquanto o catalogo
 * crescia para quinze. O resultado: oito efeitos — `fire`, `strobe`, `wave`,
 * `comet`, `scan`, `chase`, `twinkle`, `alternating` — eram recusados aqui com
 * "atribuicao invalida" antes de chegar ao hardware. Da UI, parecia que
 * escolher "Chama" na memoria simplesmente dava erro.
 *
 * O tipo nao protegeu porque `readonly EffectKind[]` aceita um SUBCONJUNTO:
 * uma lista incompleta continua valida para o compilador. Derivar do catalogo
 * remove a possibilidade de divergir.
 */
const EFFECT_KINDS: readonly EffectKind[] = EFFECT_DESCRIPTORS.map((d) => d.kind);

export function sanitizeEffectParams(value: unknown): EffectParams {
  const raw = isRecord(value) ? value : {};
  const colors = sanitizeRgbList(raw.colors);
  return {
    colors: colors.length > 0 ? colors : [...DEFAULT_EFFECT_PARAMS.colors],
    speed: isFiniteNumber(raw.speed) ? clamp(raw.speed, 0, 100) : DEFAULT_EFFECT_PARAMS.speed,
    brightness: isFiniteNumber(raw.brightness) ? clamp(raw.brightness, 0, 100) : DEFAULT_EFFECT_PARAMS.brightness,
    direction: raw.direction === 'reverse' ? 'reverse' : 'forward',
    spread: isFiniteNumber(raw.spread) ? clamp(Math.round(raw.spread), 1, 1024) : DEFAULT_EFFECT_PARAMS.spread,
  };
}

function sanitizeEffectSpec(value: unknown): EffectSpec | null {
  if (!isRecord(value)) return null;
  const kind = EFFECT_KINDS.find((candidate) => candidate === value.kind);
  if (!kind) return null;
  return { kind, params: sanitizeEffectParams(value.params) };
}

/** Valida uma atribuicao (hardware ou efeito do Lumen). `null` = rejeitada. */
export function sanitizeAssignment(value: unknown): Assignment | null {
  if (!isRecord(value)) return null;

  if (value.mode === 'lumen') {
    const effect = sanitizeEffectSpec(value.effect);
    return effect ? { mode: 'lumen', effect } : null;
  }

  if (value.mode === 'hardware') {
    if (!isFiniteNumber(value.modeIndex) || value.modeIndex < 0) return null;
    const assignment: Assignment = {
      mode: 'hardware',
      modeIndex: Math.round(value.modeIndex),
      colors: sanitizeRgbList(value.colors),
    };
    if (isFiniteNumber(value.speed)) assignment.speed = Math.round(value.speed);
    if (isFiniteNumber(value.brightness)) assignment.brightness = Math.round(value.brightness);
    if (isFiniteNumber(value.direction)) assignment.direction = Math.round(value.direction);
    return assignment;
  }

  return null;
}

/** Valida uma referencia de alvo. `null` = rejeitada. */
export function sanitizeTargetRef(value: unknown): TargetRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.deviceId !== 'string' || value.deviceId.length === 0 || value.deviceId.length > 256) return null;

  const target: TargetRef = { deviceId: value.deviceId };
  if (value.zoneIndex !== undefined && value.zoneIndex !== null) {
    if (!isFiniteNumber(value.zoneIndex) || value.zoneIndex < 0) return null;
    target.zoneIndex = Math.round(value.zoneIndex);
  }
  return target;
}

function sanitizeProfileEntry(value: unknown): ProfileEntry | null {
  if (!isRecord(value)) return null;
  const target = sanitizeTargetRef(value.target);
  const assignment = sanitizeAssignment(value.assignment);
  if (!target || !assignment) return null;
  return { target, assignment };
}

/** Somente caracteres seguros para nome de arquivo — o id vira o nome do JSON. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isSafeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);

const isoOrNow = (value: unknown): string => {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
};

/**
 * Normaliza um perfil cru (arquivo em disco ou payload do renderer).
 * Devolve `null` quando nem o minimo (id + nome) e recuperavel.
 */
export function sanitizeProfile(value: unknown): Profile | null {
  if (!isRecord(value)) return null;
  if (!isSafeId(value.id)) return null;

  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 120) : '';
  if (name.length === 0) return null;

  const rawEntries = Array.isArray(value.entries) ? value.entries.slice(0, 512) : [];
  const entries: ProfileEntry[] = [];
  for (const raw of rawEntries) {
    const entry = sanitizeProfileEntry(raw);
    if (entry) entries.push(entry);
    else warn(`Entrada invalida descartada no perfil "${value.id}".`);
  }

  return {
    id: value.id,
    name,
    createdAt: isoOrNow(value.createdAt),
    updatedAt: isoOrNow(value.updatedAt),
    entries,
  };
}

const THEMES: readonly Settings['theme'][] = ['system', 'light', 'dark'];

/** Aplica os defaults sobre o que estiver salvo, campo por campo. */
export function sanitizeSettings(value: unknown): Settings {
  const raw = isRecord(value) ? value : {};
  return {
    launchOnLogin: typeof raw.launchOnLogin === 'boolean' ? raw.launchOnLogin : DEFAULT_SETTINGS.launchOnLogin,
    startMinimized: typeof raw.startMinimized === 'boolean' ? raw.startMinimized : DEFAULT_SETTINGS.startMinimized,
    bootProfileId: isSafeId(raw.bootProfileId) ? raw.bootProfileId : DEFAULT_SETTINGS.bootProfileId,
    theme: THEMES.find((candidate) => candidate === raw.theme) ?? DEFAULT_SETTINGS.theme,
    effectFps: isFiniteNumber(raw.effectFps) ? clamp(Math.round(raw.effectFps), 1, 144) : DEFAULT_SETTINGS.effectFps,
    stopConflictingSoftware:
      typeof raw.stopConflictingSoftware === 'boolean'
        ? raw.stopConflictingSoftware
        : DEFAULT_SETTINGS.stopConflictingSoftware,
  };
}


/** Gera um id de perfil seguro para uso como nome de arquivo. */
export function newProfileId(): string {
  return randomUUID();
}

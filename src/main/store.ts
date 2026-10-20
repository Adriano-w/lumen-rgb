/**
 * Persistencia do Lumen.
 *
 * Duas camadas distintas, de proposito:
 *
 * 1. Preferencias (`Settings`) — chave/valor no `electron-store`
 *    (`userData/settings.json`).
 * 2. Perfis (`Profile`) — um arquivo JSON por perfil em `userData/profiles/`.
 *    Perfis sao documentos compartilhaveis: o usuario precisa poder copiar,
 *    mandar por mensagem e colar na pasta de outra maquina.
 *
 * Tudo que entra aqui e tratado como hostil: arquivo corrompido, campo faltando
 * ou tipo errado nunca derruba o boot — o registro e descartado com log.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import Store from 'electron-store';
import {
  DEFAULT_EFFECT_PARAMS,
  DEFAULT_SETTINGS,
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
import { createScopedLogger } from './logger.js';

const log = createScopedLogger('store');

/* ------------------------------------------------------------------ *
 * Validadores primitivos                                             *
 * ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
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

const EFFECT_KINDS: readonly EffectKind[] = [
  'static',
  'breathing',
  'rainbow-wave',
  'color-cycle',
  'gradient',
  'audio-level',
  'ambient-screen',
];

function sanitizeEffectParams(value: unknown): EffectParams {
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

const isSafeId = (value: unknown): value is string => typeof value === 'string' && SAFE_ID.test(value);

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
    else log.warn(`Entrada invalida descartada no perfil "${value.id}".`);
  }

  return {
    id: value.id,
    name,
    createdAt: isoOrNow(value.createdAt),
    updatedAt: isoOrNow(value.updatedAt),
    entries,
  };
}

/** Gera um id de perfil seguro para uso como nome de arquivo. */
export function newProfileId(): string {
  return randomUUID();
}

/* ------------------------------------------------------------------ *
 * Preferencias                                                       *
 * ------------------------------------------------------------------ */

type SettingsSchema = { settings: Settings };

let settingsStore: Store<SettingsSchema> | null = null;

function getSettingsStore(): Store<SettingsSchema> {
  if (!settingsStore) {
    settingsStore = new Store<SettingsSchema>({
      name: 'settings',
      defaults: { settings: { ...DEFAULT_SETTINGS } },
      clearInvalidConfig: true,
    });
  }
  return settingsStore;
}

const THEMES: readonly Settings['theme'][] = ['system', 'light', 'dark'];

/** Aplica os defaults sobre o que estiver salvo, campo por campo. */
function sanitizeSettings(value: unknown): Settings {
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

/** Preferencias atuais, sempre completas e com tipos validos. */
export function getSettings(): Settings {
  try {
    return sanitizeSettings(getSettingsStore().get('settings'));
  } catch (error) {
    log.error('Falha ao ler as preferencias; usando os valores padrao.', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/** Grava um patch parcial e devolve o estado resultante. */
export function setSettings(patch: Partial<Settings>): Settings {
  const next = sanitizeSettings({ ...getSettings(), ...(isRecord(patch) ? patch : {}) });
  try {
    getSettingsStore().set('settings', next);
  } catch (error) {
    log.error('Falha ao gravar as preferencias.', error);
  }
  return next;
}

/* ------------------------------------------------------------------ *
 * Perfis                                                             *
 * ------------------------------------------------------------------ */

function profilesDir(): string {
  const dir = join(app.getPath('userData'), 'profiles');
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (error) {
    log.error('Nao foi possivel criar a pasta de perfis.', error);
  }
  return dir;
}

function profilePath(id: string): string {
  return join(profilesDir(), `${id}.json`);
}

/** Caminho da pasta de perfis — exposto para o menu "abrir pasta de perfis". */
export function getProfilesDir(): string {
  return profilesDir();
}

/**
 * Le todos os perfis do disco. Arquivos ilegiveis ou invalidos sao ignorados
 * (com log) em vez de propagar excecao.
 */
export function listProfiles(): Profile[] {
  let files: string[];
  try {
    files = readdirSync(profilesDir()).filter((file) => file.toLowerCase().endsWith('.json'));
  } catch (error) {
    log.error('Falha ao listar a pasta de perfis.', error);
    return [];
  }

  const profiles: Profile[] = [];
  for (const file of files) {
    const full = join(profilesDir(), file);
    try {
      const parsed: unknown = JSON.parse(readFileSync(full, 'utf-8'));
      const profile = sanitizeProfile(parsed);
      if (!profile) {
        log.warn(`Perfil ignorado (conteudo invalido): ${file}`);
        continue;
      }
      // O nome do arquivo manda — evita dois perfis com o mesmo id em memoria.
      const idFromFile = file.slice(0, -'.json'.length);
      profiles.push(idFromFile === profile.id ? profile : { ...profile, id: idFromFile });
    } catch (error) {
      log.warn(`Perfil ignorado (JSON corrompido): ${file}`, error);
    }
  }

  profiles.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return profiles;
}

/** Um perfil pelo id, ou `null` se nao existir / estiver corrompido. */
export function getProfile(id: string): Profile | null {
  if (!isSafeId(id)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(profilePath(id), 'utf-8'));
    const profile = sanitizeProfile(parsed);
    return profile ? { ...profile, id } : null;
  } catch {
    return null;
  }
}

/**
 * Grava um perfil. Id ausente ou invalido gera um novo.
 * A escrita e atomica (arquivo temporario + rename) para nao deixar JSON
 * truncado se o processo morrer no meio.
 */
export function saveProfile(input: unknown): Profile {
  const raw = isRecord(input) ? input : {};
  const id = isSafeId(raw.id) ? raw.id : newProfileId();
  const existing = getProfile(id);

  const candidate = sanitizeProfile({
    ...raw,
    id,
    createdAt: existing?.createdAt ?? raw.createdAt,
    updatedAt: new Date().toISOString(),
  });

  if (!candidate) {
    throw new Error('Perfil invalido: e necessario informar um nome.');
  }

  const target = profilePath(id);
  const temp = `${target}.tmp`;
  writeFileSync(temp, `${JSON.stringify(candidate, null, 2)}\n`, 'utf-8');
  renameSync(temp, target);
  log.info(`Perfil salvo: ${candidate.name} (${id})`);
  return candidate;
}

/** Remove um perfil do disco. Idempotente. */
export function deleteProfile(id: string): void {
  if (!isSafeId(id)) throw new Error('Identificador de perfil invalido.');
  try {
    unlinkSync(profilePath(id));
    log.info(`Perfil removido: ${id}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  }

  // Um perfil apagado nao pode continuar sendo o perfil de boot.
  if (getSettings().bootProfileId === id) {
    setSettings({ bootProfileId: null });
  }
}

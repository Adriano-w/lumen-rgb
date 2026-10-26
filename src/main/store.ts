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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import Store from 'electron-store';
import { DEFAULT_SETTINGS, type Profile, type Settings } from '../shared/types.js';
import { createScopedLogger } from './logger.js';
import {
  isRecord,
  isSafeId,
  newProfileId,
  sanitizeProfile,
  sanitizeSettings,
  setValidationWarn,
} from './validation.js';

const log = createScopedLogger('store');

// O modulo de validacao nao conhece o logger de proposito (ver o comentario
// de cabecalho dele); ligamos o nosso aqui.
setValidationWarn((message) => log.warn(message));

// Os validadores moraram aqui e foram separados: sao funcoes puras, e manter
// este modulo (que importa `electron`) fora do caminho delas permite
// exercita-las num teste comum. Reexportamos para nao quebrar quem ja
// importava daqui.
export * from './validation.js';

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

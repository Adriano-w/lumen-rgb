/**
 * Ponte de IPC entre o renderer e o motor.
 *
 * Um canal por metodo de `LumenApi`, com o prefixo `lumen:`.
 * Todo argumento que cruza a fronteira e revalidado aqui — o renderer nunca
 * e tratado como fonte confiavel, mesmo sendo codigo nosso.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type {
  Device,
  Diagnostics,
  EngineStatus,
  Profile,
  Settings,
} from '../shared/types.js';
import type { Engine } from './engine/engine.js';
import { createScopedLogger } from './logger.js';
import {
  deleteProfile,
  getProfile,
  getSettings,
  listProfiles,
  sanitizeAssignment,
  sanitizeTargetRef,
  saveProfile,
  setSettings,
} from './store.js';
import { broadcast } from './window.js';

const log = createScopedLogger('ipc');

/* ------------------------------------------------------------------ *
 * Nomes de canal — unica fonte da verdade, usada tambem pelo preload *
 * ------------------------------------------------------------------ */

export const IPC = {
  getStatus: 'lumen:getStatus',
  getDiagnostics: 'lumen:getDiagnostics',
  listDevices: 'lumen:listDevices',
  rescan: 'lumen:rescan',
  apply: 'lumen:apply',
  applyAll: 'lumen:applyAll',
  resizeZone: 'lumen:resizeZone',
  listProfiles: 'lumen:listProfiles',
  saveProfile: 'lumen:saveProfile',
  loadProfile: 'lumen:loadProfile',
  deleteProfile: 'lumen:deleteProfile',
  getSettings: 'lumen:getSettings',
  setSettings: 'lumen:setSettings',
  devicesChanged: 'lumen:devicesChanged',
  statusChanged: 'lumen:statusChanged',
} as const;

/* ------------------------------------------------------------------ *
 * Validacao de argumentos                                            *
 * ------------------------------------------------------------------ */

/** Erro de validacao — a mensagem chega ao renderer como rejeicao da Promise. */
class IpcValidationError extends Error {
  constructor(channel: string, detail: string) {
    super(`[${channel}] argumento invalido: ${detail}`);
    this.name = 'IpcValidationError';
  }
}

function requireString(channel: string, value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new IpcValidationError(channel, `"${field}" deve ser uma string de 1 a ${maxLength} caracteres.`);
  }
  return value;
}

function requireIndex(channel: string, value: unknown, field: string, max = 65535): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    throw new IpcValidationError(channel, `"${field}" deve ser um inteiro entre 0 e ${max}.`);
  }
  return value;
}

const SETTINGS_KEYS: readonly (keyof Settings)[] = [
  'launchOnLogin',
  'startMinimized',
  'bootProfileId',
  'theme',
  'effectFps',
  'stopConflictingSoftware',
];

/** Mantem somente as chaves conhecidas de `Settings`; o store faz o resto. */
function pickSettingsPatch(channel: string, value: unknown): Partial<Settings> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new IpcValidationError(channel, 'esperado um objeto com campos de preferencias.');
  }
  const source = value as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    if (key in source) patch[key] = source[key];
  }
  return patch as Partial<Settings>;
}

/* ------------------------------------------------------------------ *
 * Registro                                                          *
 * ------------------------------------------------------------------ */

export interface RegisterIpcOptions {
  engine: Engine;
  /** Chamado apos qualquer gravacao de preferencias (login automatico, tray). */
  onSettingsChanged?: (settings: Settings) => void;
  /** Chamado quando a lista de perfis muda (para o menu da bandeja). */
  onProfilesChanged?: () => void;
}

/**
 * Registra todos os canais e a ponte de eventos do motor.
 * Devolve a funcao de limpeza (usada no encerramento).
 */
export function registerIpc(options: RegisterIpcOptions): () => void {
  const { engine, onSettingsChanged, onProfilesChanged } = options;

  /** Envolve o handler para logar a falha antes de rejeitar no renderer. */
  const handle = <T>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        return await handler(event, ...args);
      } catch (error) {
        log.error(`Falha em ${channel}`, error);
        throw error;
      }
    });
  };

  handle<EngineStatus>(IPC.getStatus, () => engine.getStatus());

  handle<Diagnostics>(IPC.getDiagnostics, () => engine.getDiagnostics());

  handle<Device[]>(IPC.listDevices, () => engine.listDevices());

  handle<Device[]>(IPC.rescan, () => engine.rescan());

  handle<void>(IPC.apply, async (_event, rawTarget, rawAssignment) => {
    const target = sanitizeTargetRef(rawTarget);
    if (!target) throw new IpcValidationError(IPC.apply, 'alvo (TargetRef) invalido.');
    const assignment = sanitizeAssignment(rawAssignment);
    if (!assignment) throw new IpcValidationError(IPC.apply, 'atribuicao (Assignment) invalida.');
    await engine.apply(target, assignment);
  });

  handle<void>(IPC.applyAll, async (_event, rawAssignment) => {
    const assignment = sanitizeAssignment(rawAssignment);
    if (!assignment) throw new IpcValidationError(IPC.applyAll, 'atribuicao (Assignment) invalida.');
    await engine.applyAll(assignment);
  });

  handle<void>(IPC.resizeZone, async (_event, rawDeviceId, rawZoneIndex, rawLedsCount) => {
    const deviceId = requireString(IPC.resizeZone, rawDeviceId, 'deviceId');
    const zoneIndex = requireIndex(IPC.resizeZone, rawZoneIndex, 'zoneIndex', 1023);
    const ledsCount = requireIndex(IPC.resizeZone, rawLedsCount, 'ledsCount', 4096);
    await engine.resizeZone(deviceId, zoneIndex, ledsCount);
  });

  handle<Profile[]>(IPC.listProfiles, () => listProfiles());

  handle<Profile>(IPC.saveProfile, (_event, rawProfile) => {
    const saved = saveProfile(rawProfile);
    onProfilesChanged?.();
    return saved;
  });

  handle<void>(IPC.loadProfile, async (_event, rawId) => {
    const id = requireString(IPC.loadProfile, rawId, 'id', 64);
    const profile = getProfile(id);
    if (!profile) throw new IpcValidationError(IPC.loadProfile, `perfil "${id}" nao encontrado.`);
    await engine.applyProfile(profile);
  });

  handle<void>(IPC.deleteProfile, (_event, rawId) => {
    const id = requireString(IPC.deleteProfile, rawId, 'id', 64);
    deleteProfile(id);
    onProfilesChanged?.();
  });

  handle<Settings>(IPC.getSettings, () => getSettings());

  handle<Settings>(IPC.setSettings, (_event, rawPatch) => {
    const patch = pickSettingsPatch(IPC.setSettings, rawPatch);
    const next = setSettings(patch);
    onSettingsChanged?.(next);
    return next;
  });

  // Eventos do motor -> todas as janelas.
  const unsubscribers = [
    engine.on('devicesChanged', (devices) => broadcast(IPC.devicesChanged, devices)),
    engine.on('statusChanged', (status) => {
      log.info('Status do motor:', status.state);
      broadcast(IPC.statusChanged, status);
    }),
  ];

  log.info(`IPC registrado: ${Object.keys(IPC).length} canais.`);

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel);
  };
}

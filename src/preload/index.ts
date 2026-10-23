/**
 * Preload do Lumen.
 *
 * Expoe exatamente `LumenApi` em `window.lumen`, nada mais. O renderer nunca
 * ve `ipcRenderer` nem qualquer modulo de Node.
 *
 * Os nomes de canal sao repetidos aqui de proposito: importar `src/main/ipc.ts`
 * arrastaria `ipcMain`, o store e o logger para dentro do bundle do preload.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  ApplyManyResult,
  Assignment,
  Device,
  Diagnostics,
  EngineStatus,
  LumenApi,
  Profile,
  Settings,
  TargetRef,
} from '../shared/types.js';

const CHANNEL = {
  getStatus: 'lumen:getStatus',
  getDiagnostics: 'lumen:getDiagnostics',
  listDevices: 'lumen:listDevices',
  rescan: 'lumen:rescan',
  apply: 'lumen:apply',
  applyAll: 'lumen:applyAll',
  applyMany: 'lumen:applyMany',
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

/**
 * Assina um canal de evento e devolve a funcao de cancelamento.
 * O payload e repassado sem o objeto `IpcRendererEvent`.
 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: LumenApi = {
  getStatus: (): Promise<EngineStatus> => ipcRenderer.invoke(CHANNEL.getStatus) as Promise<EngineStatus>,

  getDiagnostics: (): Promise<Diagnostics> => ipcRenderer.invoke(CHANNEL.getDiagnostics) as Promise<Diagnostics>,

  listDevices: (): Promise<Device[]> => ipcRenderer.invoke(CHANNEL.listDevices) as Promise<Device[]>,

  rescan: (): Promise<Device[]> => ipcRenderer.invoke(CHANNEL.rescan) as Promise<Device[]>,

  apply: (target: TargetRef, assignment: Assignment): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.apply, target, assignment) as Promise<void>,

  applyAll: (assignment: Assignment): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.applyAll, assignment) as Promise<void>,

  applyMany: (deviceIds: readonly string[], assignment: Assignment): Promise<ApplyManyResult> =>
    ipcRenderer.invoke(CHANNEL.applyMany, deviceIds, assignment) as Promise<ApplyManyResult>,

  resizeZone: (deviceId: string, zoneIndex: number, ledsCount: number): Promise<void> =>
    ipcRenderer.invoke(CHANNEL.resizeZone, deviceId, zoneIndex, ledsCount) as Promise<void>,

  listProfiles: (): Promise<Profile[]> => ipcRenderer.invoke(CHANNEL.listProfiles) as Promise<Profile[]>,

  saveProfile: (profile: Profile): Promise<Profile> =>
    ipcRenderer.invoke(CHANNEL.saveProfile, profile) as Promise<Profile>,

  loadProfile: (id: string): Promise<void> => ipcRenderer.invoke(CHANNEL.loadProfile, id) as Promise<void>,

  deleteProfile: (id: string): Promise<void> => ipcRenderer.invoke(CHANNEL.deleteProfile, id) as Promise<void>,

  getSettings: (): Promise<Settings> => ipcRenderer.invoke(CHANNEL.getSettings) as Promise<Settings>,

  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(CHANNEL.setSettings, patch) as Promise<Settings>,

  onDevicesChanged: (cb: (devices: Device[]) => void): (() => void) =>
    subscribe<Device[]>(CHANNEL.devicesChanged, cb),

  onStatusChanged: (cb: (status: EngineStatus) => void): (() => void) =>
    subscribe<EngineStatus>(CHANNEL.statusChanged, cb),
};

// `contextIsolation: true` garante que isto e a unica superficie visivel.
contextBridge.exposeInMainWorld('lumen', api);

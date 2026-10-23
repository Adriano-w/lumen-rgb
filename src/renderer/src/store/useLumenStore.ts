import { create } from 'zustand';

import {
  DEFAULT_EFFECT_PARAMS,
  DEFAULT_SETTINGS,
  type Assignment,
  type Device,
  type Diagnostics,
  type EngineStatus,
  type Profile,
  type ProfileEntry,
  type RGB,
  type Settings,
  type TargetRef,
} from '@shared/types';

import { api } from '@renderer/lib/api';
import { BLACK, PRESET_COLORS, sameColor } from '@renderer/lib/color';
import { deviceLabel, targetKey } from '@renderer/lib/devices';
import { clamp, createId } from '@renderer/lib/utils';

/** Fases do carregamento inicial — cada uma tem uma tela desenhada. */
export type Phase = 'loading' | 'ready' | 'error';

/** Acoes que mostram estado de "trabalhando" na UI. */
export type BusyKey = 'rescan' | 'applyAll' | 'profile' | 'settings' | 'bulk';

/** O que o painel principal esta mostrando. */
export type MainView = 'device' | 'all';

/** Andamento de uma aplicacao em lote, device a device. */
export interface BulkProgress {
  total: number;
  /** Quantos ja terminaram (com sucesso ou nao). */
  done: number;
  /** Nome do device sendo escrito agora. */
  currentName: string;
}

export interface BulkFailure {
  deviceId: string;
  name: string;
  reason: string;
}

/** Saldo de uma aplicacao em lote. Nomes prontos para a tela. */
export interface BulkResult {
  applied: string[];
  failed: BulkFailure[];
  /** Selecionados que a tela nao tinha como atender. */
  skipped: string[];
}

const MAX_RECENT_COLORS = 12;

interface LumenState {
  /* --- Carregamento --- */
  phase: Phase;
  errorMessage: string | null;
  busy: Record<string, boolean>;

  /* --- Dados do backend --- */
  devices: Device[];
  status: EngineStatus | null;
  diagnostics: Diagnostics | null;
  profiles: Profile[];
  settings: Settings;

  /* --- Selecao e estado de UI --- */
  /** Painel principal: um device so, ou a tela de todos. */
  view: MainView;
  selectedDeviceId: string | null;
  /** `undefined` = device inteiro. */
  selectedZoneIndex: number | undefined;
  recentColors: RGB[];
  globalBrightness: number;
  /** Atribuicoes feitas nesta sessao, indexadas por `targetKey`. */
  assignments: Record<string, Assignment>;
  /** Perfil aplicado por ultimo, para destacar na lista. */
  activeProfileId: string | null;

  /* --- Aplicacao em lote (tela "Todos os devices") --- */
  bulkProgress: BulkProgress | null;
  bulkResult: BulkResult | null;

  /* --- Acoes --- */
  bootstrap: () => Promise<void>;
  rescan: () => Promise<void>;

  selectDevice: (deviceId: string) => void;
  selectZone: (zoneIndex: number | undefined) => void;
  showAllDevices: () => void;

  applyAssignment: (target: TargetRef, assignment: Assignment) => Promise<void>;
  applyToDevices: (
    deviceIds: string[],
    assignment: Assignment,
    skippedIds?: string[],
  ) => Promise<void>;
  clearBulkResult: () => void;
  setGlobalBrightness: (value: number) => void;
  commitGlobalBrightness: () => Promise<void>;
  turnEverythingOff: () => Promise<void>;

  pushRecentColor: (color: RGB) => void;

  saveCurrentProfile: (name: string) => Promise<void>;
  applyProfile: (id: string) => Promise<void>;
  renameProfile: (id: string, name: string) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  reorderProfiles: (activeId: string, overId: string) => void;

  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  dismissError: () => void;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const useLumenStore = create<LumenState>()((set, get) => {
  /** Marca/desmarca uma acao como em andamento. */
  const setBusy = (key: BusyKey, value: boolean): void => {
    set((state) => ({ busy: { ...state.busy, [key]: value } }));
  };

  /**
   * Reaplica o brilho global sobre as atribuicoes conhecidas.
   * `LumenApi` nao tem um comando de brilho global, entao a UI reescreve
   * cada atribuicao desta sessao com o novo valor.
   */
  const reapplyBrightness = async (): Promise<void> => {
    const { assignments, devices, globalBrightness } = get();

    const jobs: Promise<void>[] = [];

    for (const [key, assignment] of Object.entries(assignments)) {
      const [deviceId, zonePart] = key.split('#');
      const zoneIndex = zonePart === undefined ? undefined : Number(zonePart);
      const device = devices.find((item) => item.id === deviceId);
      if (!device) continue;

      if (assignment.mode === 'lumen') {
        jobs.push(
          api.apply(
            { deviceId, zoneIndex },
            {
              mode: 'lumen',
              effect: {
                ...assignment.effect,
                params: { ...assignment.effect.params, brightness: globalBrightness },
              },
            },
          ),
        );
        continue;
      }

      // Modo de hardware: so mexe quando o modo declara suporte a brilho.
      const mode = device.modes[assignment.modeIndex];
      if (!mode?.brightness) continue;
      const { min, max } = mode.brightness;
      const scaled = Math.round(min + ((max - min) * globalBrightness) / 100);
      jobs.push(api.apply({ deviceId, zoneIndex }, { ...assignment, brightness: scaled }));
    }

    await Promise.all(jobs);
  };

  return {
    phase: 'loading',
    errorMessage: null,
    busy: {},

    devices: [],
    status: null,
    diagnostics: null,
    profiles: [],
    settings: DEFAULT_SETTINGS,

    view: 'device',
    selectedDeviceId: null,
    selectedZoneIndex: undefined,
    recentColors: PRESET_COLORS.slice(0, 6),
    globalBrightness: 100,
    assignments: {},
    activeProfileId: null,

    bulkProgress: null,
    bulkResult: null,

    async bootstrap() {
      set({ phase: 'loading', errorMessage: null });

      try {
        const [status, settings] = await Promise.all([api.getStatus(), api.getSettings()]);
        set({ status, settings, activeProfileId: settings.bootProfileId });

        // Diagnostico, devices e perfis sao independentes: uma falha num
        // deles nao deve derrubar a tela inteira.
        const [diagnostics, devices, profiles] = await Promise.all([
          api.getDiagnostics().catch(() => null),
          api.listDevices().catch(() => [] as Device[]),
          api.listProfiles().catch(() => [] as Profile[]),
        ]);

        set((state) => ({
          phase: 'ready',
          diagnostics,
          devices,
          profiles,
          selectedDeviceId: state.selectedDeviceId ?? devices[0]?.id ?? null,
        }));

        api.onDevicesChanged((next) => {
          set((state) => ({
            devices: next,
            selectedDeviceId:
              state.selectedDeviceId && next.some((device) => device.id === state.selectedDeviceId)
                ? state.selectedDeviceId
                : (next[0]?.id ?? null),
          }));
        });

        api.onStatusChanged((next) => {
          set({ status: next });
          // Reconectou: vale revalidar a lista e o diagnostico.
          if (next.state === 'connected') {
            void api.listDevices().then((devices) => set({ devices }));
            void api.getDiagnostics().then((diagnostics) => set({ diagnostics }));
          }
        });
      } catch (error) {
        set({ phase: 'error', errorMessage: describeError(error) });
      }
    },

    async rescan() {
      setBusy('rescan', true);
      try {
        const [devices, diagnostics] = await Promise.all([
          api.rescan(),
          api.getDiagnostics().catch(() => get().diagnostics),
        ]);
        set((state) => ({
          devices,
          diagnostics,
          selectedDeviceId:
            state.selectedDeviceId && devices.some((device) => device.id === state.selectedDeviceId)
              ? state.selectedDeviceId
              : (devices[0]?.id ?? null),
          selectedZoneIndex: undefined,
        }));
      } catch (error) {
        set({ errorMessage: describeError(error) });
      } finally {
        setBusy('rescan', false);
      }
    },

    selectDevice(deviceId) {
      const state = get();
      // Escolher um device tambem e sair da tela de todos — e o saldo do
      // ultimo lote nao faz sentido fora dela.
      if (state.selectedDeviceId === deviceId) {
        if (state.view !== 'device') set({ view: 'device', bulkResult: null });
        return;
      }
      set({
        selectedDeviceId: deviceId,
        selectedZoneIndex: undefined,
        view: 'device',
        bulkResult: null,
      });
    },

    selectZone(zoneIndex) {
      set({ selectedZoneIndex: zoneIndex });
    },

    showAllDevices() {
      if (get().view === 'all') return;
      set({ view: 'all' });
    },

    async applyAssignment(target, assignment) {
      const key = targetKey(target.deviceId, target.zoneIndex);

      // Otimista: a UI responde na hora, o backend confirma depois.
      set((state) => ({
        assignments: { ...state.assignments, [key]: assignment },
        errorMessage: null,
      }));

      try {
        await api.apply(target, assignment);
      } catch (error) {
        set({ errorMessage: describeError(error) });
      }
    },

    async applyToDevices(deviceIds, assignment, skippedIds = []) {
      const nameOf = (deviceId: string): string => {
        const device = get().devices.find((item) => item.id === deviceId);
        return device ? deviceLabel(device) : deviceId;
      };

      const skipped = skippedIds.map(nameOf);

      if (deviceIds.length === 0) {
        set({ bulkProgress: null, bulkResult: { applied: [], failed: [], skipped } });
        return;
      }

      setBusy('bulk', true);
      set({
        errorMessage: null,
        bulkResult: null,
        bulkProgress: { total: deviceIds.length, done: 0, currentName: nameOf(deviceIds[0]) },
      });

      const applied: string[] = [];
      const failed: BulkFailure[] = [];

      // UMA chamada com a lista inteira, nao uma por device.
      //
      // Nao e so economia de ida e volta. O motor usa a lista para montar uma
      // fita virtual: os devices entram em sequencia e um efeito espacial
      // atravessa todos como se fossem uma fita so. Aplicando um por vez,
      // cada device recomecava o efeito do zero — todos acendendo a mesma
      // primeira cor e divergindo a partir dali, que e o oposto de
      // sincronizado.
      //
      // O backend serializa as escritas internamente, porque o SMBus aceita
      // uma transacao por vez.
      try {
        const result = await api.applyMany(deviceIds, assignment);

        for (const deviceId of result.applied) {
          applied.push(nameOf(deviceId));
          set((state) => ({
            assignments: { ...state.assignments, [targetKey(deviceId, undefined)]: assignment },
          }));
        }

        // Um device que falha nao impede os outros: a tela devolve a lista
        // exata de quem ficou de fora, e por que.
        for (const entry of result.failed) {
          failed.push({
            deviceId: entry.deviceId,
            name: nameOf(entry.deviceId),
            reason: entry.error,
          });
        }
      } catch (error) {
        // Falha da chamada inteira (backend fora do ar, validacao): todos os
        // devices ficaram de fora, pelo mesmo motivo.
        const reason = describeError(error);
        for (const deviceId of deviceIds) {
          failed.push({ deviceId, name: nameOf(deviceId), reason });
        }
      }

      set({
        bulkProgress: null,
        bulkResult: { applied, failed, skipped },
        // O que esta no hardware agora nao e mais o perfil ativo.
        activeProfileId: applied.length > 0 ? null : get().activeProfileId,
      });
      setBusy('bulk', false);
    },

    clearBulkResult() {
      set({ bulkResult: null });
    },

    setGlobalBrightness(value) {
      set({ globalBrightness: clamp(Math.round(value), 0, 100) });
    },

    async commitGlobalBrightness() {
      try {
        await reapplyBrightness();
      } catch (error) {
        set({ errorMessage: describeError(error) });
      }
    },

    async turnEverythingOff() {
      setBusy('applyAll', true);
      const off: Assignment = {
        mode: 'lumen',
        effect: {
          kind: 'static',
          params: { ...DEFAULT_EFFECT_PARAMS, colors: [BLACK], brightness: 0 },
        },
      };

      try {
        await api.applyAll(off);
        set((state) => {
          const assignments: Record<string, Assignment> = {};
          for (const device of state.devices) assignments[device.id] = off;
          return { assignments, globalBrightness: 0, activeProfileId: null };
        });
      } catch (error) {
        set({ errorMessage: describeError(error) });
      } finally {
        setBusy('applyAll', false);
      }
    },

    pushRecentColor(color) {
      set((state) => {
        const rest = state.recentColors.filter((item) => !sameColor(item, color));
        return { recentColors: [color, ...rest].slice(0, MAX_RECENT_COLORS) };
      });
    },

    async saveCurrentProfile(name) {
      setBusy('profile', true);

      const { assignments, profiles } = get();
      const entries: ProfileEntry[] = Object.entries(assignments).map(([key, assignment]) => {
        const [deviceId, zonePart] = key.split('#');
        return {
          target: { deviceId, zoneIndex: zonePart === undefined ? undefined : Number(zonePart) },
          assignment,
        };
      });

      const now = new Date().toISOString();
      const profile: Profile = {
        id: createId('profile'),
        name: name.trim() || `Perfil ${profiles.length + 1}`,
        createdAt: now,
        updatedAt: now,
        entries,
      };

      try {
        const saved = await api.saveProfile(profile);
        set((state) => ({
          profiles: [...state.profiles, saved],
          activeProfileId: saved.id,
        }));
      } catch (error) {
        set({ errorMessage: describeError(error) });
      } finally {
        setBusy('profile', false);
      }
    },

    async applyProfile(id) {
      setBusy('profile', true);
      try {
        await api.loadProfile(id);
        const profile = get().profiles.find((item) => item.id === id);

        // Espelha o perfil nas atribuicoes locais, para os controles
        // mostrarem o que o perfil acabou de aplicar.
        const assignments: Record<string, Assignment> = {};
        for (const entry of profile?.entries ?? []) {
          assignments[targetKey(entry.target.deviceId, entry.target.zoneIndex)] = entry.assignment;
        }

        set((state) => ({
          activeProfileId: id,
          assignments: profile?.entries.length ? assignments : state.assignments,
        }));

        const devices = await api.listDevices();
        set({ devices });
      } catch (error) {
        set({ errorMessage: describeError(error) });
      } finally {
        setBusy('profile', false);
      }
    },

    async renameProfile(id, name) {
      const profile = get().profiles.find((item) => item.id === id);
      if (!profile) return;

      const trimmed = name.trim();
      if (!trimmed || trimmed === profile.name) return;

      setBusy('profile', true);
      try {
        const saved = await api.saveProfile({ ...profile, name: trimmed });
        set((state) => ({
          profiles: state.profiles.map((item) => (item.id === id ? saved : item)),
        }));
      } catch (error) {
        set({ errorMessage: describeError(error) });
      } finally {
        setBusy('profile', false);
      }
    },

    async removeProfile(id) {
      setBusy('profile', true);
      try {
        await api.deleteProfile(id);
        set((state) => ({
          profiles: state.profiles.filter((item) => item.id !== id),
          activeProfileId: state.activeProfileId === id ? null : state.activeProfileId,
          settings:
            state.settings.bootProfileId === id
              ? { ...state.settings, bootProfileId: null }
              : state.settings,
        }));
      } catch (error) {
        set({ errorMessage: describeError(error) });
      } finally {
        setBusy('profile', false);
      }
    },

    reorderProfiles(activeId, overId) {
      // Ordem e so da UI: `Profile` nao tem campo de ordenacao e `LumenApi`
      // nao expoe reordenacao, entao isso nao persiste entre sessoes.
      set((state) => {
        const from = state.profiles.findIndex((item) => item.id === activeId);
        const to = state.profiles.findIndex((item) => item.id === overId);
        if (from < 0 || to < 0 || from === to) return state;

        const next = [...state.profiles];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        return { profiles: next };
      });
    },

    async updateSettings(patch) {
      // Otimista: o tema precisa trocar na hora, sem esperar o disco.
      const previous = get().settings;
      set({ settings: { ...previous, ...patch } });

      setBusy('settings', true);
      try {
        const saved = await api.setSettings(patch);
        set({ settings: saved });
      } catch (error) {
        set({ settings: previous, errorMessage: describeError(error) });
      } finally {
        setBusy('settings', false);
      }
    },

    dismissError() {
      set({ errorMessage: null });
    },
  };
});

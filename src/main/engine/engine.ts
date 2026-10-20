/**
 * Contrato publico do motor do Lumen.
 *
 * A camada Electron (janela, tray, IPC) depende SO desta interface — nunca dos
 * modulos internos de `engine/`. Isso mantem o shell e o motor substituiveis
 * de forma independente.
 */
import type {
  Assignment,
  Device,
  Diagnostics,
  EngineStatus,
  Profile,
  TargetRef,
} from '../../shared/types.js';

export interface EngineEvents {
  devicesChanged: (devices: Device[]) => void;
  statusChanged: (status: EngineStatus) => void;
  diagnosticsChanged: (diagnostics: Diagnostics) => void;
}

export interface Engine {
  /** Sobe o backend e conecta. Resolve mesmo em falha — veja `getStatus()`. */
  start(): Promise<void>;
  /** Para efeitos, desconecta e encerra o backend que nos iniciamos. */
  stop(): Promise<void>;

  getStatus(): EngineStatus;
  getDiagnostics(): Promise<Diagnostics>;
  listDevices(): Device[];
  /** Forca redeteccao no backend e devolve a lista nova. */
  rescan(): Promise<Device[]>;

  apply(target: TargetRef, assignment: Assignment): Promise<void>;
  applyAll(assignment: Assignment): Promise<void>;
  resizeZone(deviceId: string, zoneIndex: number, ledsCount: number): Promise<void>;

  /** Aplica todas as entradas de um perfil de uma vez. */
  applyProfile(profile: Profile): Promise<void>;

  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): () => void;
}

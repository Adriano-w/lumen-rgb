/**
 * Seletores derivados.
 *
 * Todos devolvem valores estaveis por referencia (elementos do array ou
 * primitivos), para nao forcar re-render a cada `set` do store.
 */

import type { Assignment, Device, DeviceMode } from '@shared/types';

import { targetKey } from '@renderer/lib/devices';
import { useLumenStore } from './useLumenStore';

export function useSelectedDevice(): Device | null {
  return useLumenStore(
    (state) => state.devices.find((device) => device.id === state.selectedDeviceId) ?? null,
  );
}

export function useAssignmentFor(
  deviceId: string | null,
  zoneIndex: number | undefined,
): Assignment | undefined {
  return useLumenStore((state) =>
    deviceId ? state.assignments[targetKey(deviceId, zoneIndex)] : undefined,
  );
}

/** True quando o motor esta conectado e aceitando comandos. */
export function useIsConnected(): boolean {
  return useLumenStore((state) => state.status?.state === 'connected');
}

/** True quando o diagnostico aponta algum problema que a UI deve explicar. */
export function hasDiagnosticsIssue(
  diagnostics: {
    pawnIoInstalled: boolean;
    backendElevated: boolean;
    conflictingProcesses: string[];
    failedInterfaces: string[];
  } | null,
): boolean {
  if (!diagnostics) return false;
  return (
    !diagnostics.pawnIoInstalled ||
    !diagnostics.backendElevated ||
    diagnostics.conflictingProcesses.length > 0 ||
    diagnostics.failedInterfaces.length > 0
  );
}

/**
 * Atribuicao efetiva de um alvo: a desta sessao, se houver; senao uma
 * reconstruida a partir do estado atual reportado pelo hardware.
 */
export function effectiveAssignment(
  device: Device,
  zoneIndex: number | undefined,
  stored: Assignment | undefined,
): Assignment {
  if (stored) return stored;

  const modeIndex = device.activeModeIndex;
  const mode: DeviceMode | undefined = device.modes[modeIndex];

  return {
    mode: 'hardware',
    modeIndex: mode ? modeIndex : 0,
    colors: mode?.colors.length
      ? mode.colors
      : zoneIndex === undefined
        ? device.colors.slice(0, 1)
        : device.colors.slice(
            device.zones[zoneIndex]?.ledOffset ?? 0,
            (device.zones[zoneIndex]?.ledOffset ?? 0) + 1,
          ),
    speed: mode?.speed?.current,
    brightness: mode?.brightness?.current,
    direction: mode?.direction,
  };
}

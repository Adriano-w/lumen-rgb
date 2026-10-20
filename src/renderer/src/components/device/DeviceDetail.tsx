import { useCallback, useMemo } from 'react';
import { Maximize2, Save } from 'lucide-react';

import {
  DEFAULT_EFFECT_PARAMS,
  type Assignment,
  type Device,
  type RGB,
  type TargetRef,
} from '@shared/types';

import { Badge, Button, ScrollArea, Tooltip } from '@renderer/components/ui';
import { ColorStrip } from '@renderer/components/common/ColorStrip';
import { Section } from '@renderer/components/common/Section';
import { deviceIcon, deviceLabel, deviceTypeLabel, targetColors, targetLedCount, zoneOf } from '@renderer/lib/devices';
import { initialParams } from '@renderer/lib/effects';
import { effectiveAssignment } from '@renderer/store';
import { formatLeds } from '@renderer/lib/utils';

import { HardwareModePanel } from './HardwareModePanel';
import { LumenEffectsPanel } from './LumenEffectsPanel';
import { ModeSourceToggle, type ModeSource } from './ModeSourceToggle';
import { ZoneSelector } from './ZoneSelector';

export interface DeviceDetailProps {
  device: Device;
  zoneIndex: number | undefined;
  onZoneChange: (zoneIndex: number | undefined) => void;
  storedAssignment: Assignment | undefined;
  onApply: (target: TargetRef, assignment: Assignment) => void;
  recentColors: RGB[];
  onCommitColor: (color: RGB) => void;
  /** Backend fora do ar: controles ficam visiveis mas inertes. */
  offline: boolean;
  onSaveProfile: () => void;
}

export function DeviceDetail({
  device,
  zoneIndex,
  onZoneChange,
  storedAssignment,
  onApply,
  recentColors,
  onCommitColor,
  offline,
  onSaveProfile,
}: DeviceDetailProps) {
  const Icon = deviceIcon(device.type);
  const label = deviceLabel(device);
  const zone = zoneOf(device, zoneIndex);
  const leds = targetLedCount(device, zoneIndex);
  const colors = targetColors(device, zoneIndex);

  const assignment = useMemo(
    () => effectiveAssignment(device, zoneIndex, storedAssignment),
    [device, zoneIndex, storedAssignment],
  );

  const target: TargetRef = useMemo(() => ({ deviceId: device.id, zoneIndex }), [device.id, zoneIndex]);

  const apply = useCallback(
    (next: Assignment) => {
      onApply(target, next);
    },
    [onApply, target],
  );

  const source: ModeSource = assignment.mode === 'lumen' ? 'lumen' : 'hardware';

  const changeSource = (next: ModeSource): void => {
    if (next === source) return;

    if (next === 'lumen') {
      const seed = assignment.mode === 'hardware' ? assignment.colors : DEFAULT_EFFECT_PARAMS.colors;
      apply({ mode: 'lumen', effect: { kind: 'static', params: initialParams('static', seed) } });
      return;
    }

    // Volta para o hardware no primeiro modo que nao seja o Direct.
    const fallbackIndex = device.modes.findIndex((mode) => mode.index !== device.directModeIndex);
    const modeIndex = fallbackIndex >= 0 ? fallbackIndex : 0;
    const mode = device.modes[modeIndex];
    const seed = assignment.mode === 'lumen' ? assignment.effect.params.colors : [];

    apply({
      mode: 'hardware',
      modeIndex,
      colors: seed.length ? seed.slice(0, Math.max(mode?.colorsMin ?? 1, 1)) : (mode?.colors ?? []),
      speed: mode?.speed?.current,
      brightness: mode?.brightness?.current,
      direction: mode?.direction,
    });
  };

  return (
    <ScrollArea className="flex-1" viewportClassName="px-8 pb-12 pt-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
        {/* Cabecalho do device */}
        <header className="flex flex-col gap-5">
          <div className="flex items-start gap-4">
            <span
              className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-muted-foreground"
              aria-hidden
            >
              <Icon className="size-5" />
            </span>

            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h1 className="truncate text-xl font-semibold tracking-tight text-foreground">
                {label}
              </h1>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <span>{device.vendor || deviceTypeLabel(device.type)}</span>
                <span aria-hidden>-</span>
                <span>{formatLeds(device.ledCount)}</span>
                {device.zones.length > 1 ? (
                  <>
                    <span aria-hidden>-</span>
                    <span>{device.zones.length} zonas</span>
                  </>
                ) : null}
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant={device.supportsDirect ? 'primary' : 'outline'}>
                  {device.supportsDirect ? 'Aceita efeitos do Lumen' : 'Somente modos do hardware'}
                </Badge>
                <Tooltip content={device.location || device.description}>
                  <Badge variant="neutral" className="cursor-default">
                    {device.backend === 'openrgb' ? 'OpenRGB' : 'Driver nativo'}
                  </Badge>
                </Tooltip>
                {zone?.resizable ? (
                  <Tooltip content="Header ARGB: o Lumen nao sabe quantos LEDs estao ligados nele, entao esse numero pode ser ajustado.">
                    <Badge variant="info" className="cursor-default">
                      <Maximize2 aria-hidden />
                      Tamanho ajustavel
                    </Badge>
                  </Tooltip>
                ) : null}
              </div>
            </div>
          </div>

          <ColorStrip
            colors={colors}
            max={48}
            glow
            className="h-2"
            label={`Cores atuais de ${zone ? `${label} - ${zone.name}` : label}`}
          />
        </header>

        {/* Alvo */}
        {device.zones.length > 1 ? (
          <Section
            title="Onde aplicar"
            description="Escolha o device inteiro ou uma zona especifica."
          >
            <ZoneSelector device={device} value={zoneIndex} onChange={onZoneChange} />
          </Section>
        ) : null}

        {/* Fonte do modo */}
        <Section title="Como iluminar">
          <ModeSourceToggle
            value={source}
            onChange={changeSource}
            lumenAvailable={device.supportsDirect}
            disabled={offline}
          />
        </Section>

        {/* Painel do modo escolhido */}
        {assignment.mode === 'lumen' ? (
          <LumenEffectsPanel
            assignment={assignment}
            onChange={apply}
            targetLeds={leds}
            recentColors={recentColors}
            onCommitColor={onCommitColor}
            disabled={offline}
          />
        ) : (
          <HardwareModePanel
            device={device}
            assignment={assignment}
            onChange={apply}
            recentColors={recentColors}
            onCommitColor={onCommitColor}
            disabled={offline}
          />
        )}

        {/* Acao principal da tela */}
        <div className="flex items-center justify-between gap-4 border-t border-border pt-6">
          <p className="text-sm leading-relaxed text-muted-foreground">
            As mudancas valem na hora. Salve um perfil para poder voltar a esta combinacao depois.
          </p>
          <Button variant="primary" className="shrink-0" onClick={onSaveProfile} disabled={offline}>
            <Save aria-hidden />
            Salvar perfil atual
          </Button>
        </div>
      </div>
    </ScrollArea>
  );
}

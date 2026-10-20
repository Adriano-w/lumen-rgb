import { ChevronRight, Layers, Lightbulb, RefreshCw } from 'lucide-react';

import type { Device } from '@shared/types';
import { Badge, Button, ScrollArea, Tooltip } from '@renderer/components/ui';
import { ColorStrip } from '@renderer/components/common/ColorStrip';
import { deviceIcon, deviceLabel, groupDevicesByType } from '@renderer/lib/devices';
import { formatDevices } from '@renderer/lib/bulk';
import type { MainView } from '@renderer/store';
import { cn, formatLeds } from '@renderer/lib/utils';

export interface SidebarProps {
  devices: Device[];
  selectedDeviceId: string | null;
  /** Qual painel esta aberto: um device, ou a tela de todos. */
  view: MainView;
  onSelect: (deviceId: string) => void;
  onShowAll: () => void;
  onRescan: () => void;
  rescanning: boolean;
}

export function Sidebar({
  devices,
  selectedDeviceId,
  view,
  onSelect,
  onShowAll,
  onRescan,
  rescanning,
}: SidebarProps) {
  const groups = groupDevicesByType(devices);
  const totalLeds = devices.reduce((sum, device) => sum + device.ledCount, 0);

  return (
    <aside className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col border-r border-border bg-surface-1">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-4">
        <span
          className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
          aria-hidden
        >
          <Lightbulb className="size-4" />
        </span>
        <div className="flex flex-col">
          <span className="text-sm font-semibold leading-tight tracking-tight">Lumen</span>
          <span className="text-[0.6875rem] leading-tight text-subtle-foreground">
            {devices.length === 0
              ? 'Nenhum device'
              : `${devices.length} ${devices.length === 1 ? 'device' : 'devices'} - ${formatLeds(totalLeds)}`}
          </span>
        </div>
      </div>

      {/* Fixo acima da lista: nao e um device, e uma tela. */}
      {devices.length > 0 ? (
        <div className="border-b border-border p-3">
          <button
            type="button"
            onClick={onShowAll}
            aria-current={view === 'all' ? 'page' : undefined}
            className={cn(
              'group flex w-full items-center gap-3 rounded-md border px-2.5 py-2.5 text-left transition-colors',
              'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
              view === 'all'
                ? 'border-primary/45 bg-primary-soft text-accent-foreground'
                : 'border-transparent bg-surface-2 hover:border-border-strong',
            )}
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors',
                view === 'all'
                  ? 'border-primary/40 bg-card text-primary'
                  : 'border-border bg-card text-muted-foreground group-hover:text-foreground',
              )}
              aria-hidden
            >
              <Layers className="size-4" />
            </span>

            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm font-medium text-foreground">
                Todos os devices
              </span>
              <span className="text-[0.6875rem] leading-tight text-subtle-foreground">
                {`Um efeito em sincronia nos ${formatDevices(devices.length)}`}
              </span>
            </span>

            <ChevronRight
              className={cn(
                'size-4 shrink-0 transition-colors',
                view === 'all' ? 'text-primary' : 'text-subtle-foreground',
              )}
              aria-hidden
            />
          </button>
        </div>
      ) : null}

      <ScrollArea className="flex-1" viewportClassName="px-3 py-4">
        {groups.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm leading-relaxed text-muted-foreground">
            Nada por aqui ainda.
          </p>
        ) : (
          <nav aria-label="Devices encontrados" className="flex flex-col gap-5">
            {groups.map((group) => (
              <div key={group.type} className="flex flex-col gap-1">
                <h2 className="px-2.5 pb-1 text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
                  {group.label}
                </h2>

                <ul className="flex flex-col gap-0.5">
                  {group.devices.map((device) => (
                    <li key={device.id}>
                      <DeviceRow
                        device={device}
                        selected={view === 'device' && device.id === selectedDeviceId}
                        onSelect={onSelect}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        )}
      </ScrollArea>

      <div className="border-t border-border p-3">
        <Button
          variant="ghost"
          className="w-full justify-start"
          onClick={onRescan}
          disabled={rescanning}
        >
          <RefreshCw className={cn(rescanning && 'animate-spin')} aria-hidden />
          {rescanning ? 'Procurando...' : 'Procurar devices'}
        </Button>
      </div>
    </aside>
  );
}

interface DeviceRowProps {
  device: Device;
  selected: boolean;
  onSelect: (deviceId: string) => void;
}

function DeviceRow({ device, selected, onSelect }: DeviceRowProps) {
  const Icon = deviceIcon(device.type);
  const label = deviceLabel(device);

  return (
    <button
      type="button"
      onClick={() => onSelect(device.id)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'group flex w-full items-center gap-3 rounded-md px-2.5 py-2.5 text-left transition-colors',
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-surface-2',
      )}
    >
      <span
        className={cn(
          'flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors',
          selected
            ? 'border-primary/40 bg-primary-soft text-accent-foreground'
            : 'border-border bg-surface-2 text-muted-foreground group-hover:text-foreground',
        )}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              'truncate text-sm font-medium',
              selected ? 'text-foreground' : 'text-foreground/90',
            )}
          >
            {label}
          </span>
          {!device.supportsDirect ? (
            <Tooltip content="Este device nao tem modo Direct, entao aceita somente os modos do proprio hardware.">
              <Badge variant="outline" className="shrink-0">
                HW
              </Badge>
            </Tooltip>
          ) : null}
        </span>

        <span className="text-[0.6875rem] leading-none text-subtle-foreground">
          {formatLeds(device.ledCount)}
          {device.zones.length > 1 ? ` - ${device.zones.length} zonas` : ''}
        </span>

        <ColorStrip
          colors={device.colors}
          max={18}
          glow
          label={`Cores atuais de ${label}`}
          className="h-1"
        />
      </span>
    </button>
  );
}

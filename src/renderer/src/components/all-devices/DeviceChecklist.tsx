import type { Device } from '@shared/types';

import { Badge, Checkbox, Tooltip } from '@renderer/components/ui';
import { ColorStrip } from '@renderer/components/common/ColorStrip';
import { deviceIcon, deviceLabel } from '@renderer/lib/devices';
import { cn, formatLeds } from '@renderer/lib/utils';

export interface DeviceChecklistProps {
  devices: Device[];
  selectedIds: ReadonlySet<string>;
  onToggle: (deviceId: string, selected: boolean) => void;
  disabled?: boolean;
}

/**
 * Lista de devices com caixa de selecao.
 *
 * Cada linha diz na cara o que o device aceita: sem modo Direct ele nao
 * recebe efeito nenhum do Lumen, e com `writeWearRisk` cada mudanca de
 * cor vai para a flash do controlador. Essas duas coisas mudam o que vai
 * acontecer ao apertar "Aplicar", entao ficam visiveis na hora de
 * escolher, nao depois.
 */
export function DeviceChecklist({
  devices,
  selectedIds,
  onToggle,
  disabled,
}: DeviceChecklistProps) {
  return (
    <ul className="flex flex-col gap-1.5">
      {devices.map((device) => {
        const Icon = deviceIcon(device.type);
        const label = deviceLabel(device);
        const checked = selectedIds.has(device.id);
        const inputId = `bulk-${device.id}`;

        return (
          <li key={device.id}>
            <label
              htmlFor={inputId}
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors',
                'has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60',
                checked
                  ? 'border-primary/45 bg-primary-soft/40'
                  : 'border-border bg-card hover:border-border-strong hover:bg-surface-2',
              )}
            >
              <Checkbox
                id={inputId}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(value) => onToggle(device.id, value === true)}
              />

              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors',
                  checked
                    ? 'border-primary/40 bg-card text-primary'
                    : 'border-border bg-surface-2 text-muted-foreground',
                )}
                aria-hidden
              >
                <Icon className="size-4" />
              </span>

              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">{label}</span>

                  {!device.supportsDirect ? (
                    <Tooltip content="Sem modo Direct, o Lumen nao consegue pintar LED a LED neste device. Abra ele na lista a esquerda para usar os modos gravados no proprio hardware.">
                      <Badge variant="warning" className="cursor-default">
                        Sem efeitos do Lumen
                      </Badge>
                    </Tooltip>
                  ) : null}

                  {device.writeWearRisk ? (
                    <Tooltip content="O firmware deste device grava cada mudanca de cor na memoria interna, que tem um numero finito de gravacoes. Efeitos com movimento rodam em ritmo reduzido aqui para preservar o controlador.">
                      <Badge variant="info" className="cursor-default">
                        Grava na memoria
                      </Badge>
                    </Tooltip>
                  ) : null}
                </span>

                <span className="text-[0.6875rem] leading-none text-subtle-foreground">
                  {formatLeds(device.ledCount)}
                  {device.zones.length > 1 ? ` - ${device.zones.length} zonas` : ''}
                </span>
              </span>

              <ColorStrip
                colors={device.colors}
                max={16}
                glow
                label={`Cores atuais de ${label}`}
                className="hidden h-1.5 w-20 shrink-0 sm:flex"
              />
            </label>
          </li>
        );
      })}
    </ul>
  );
}

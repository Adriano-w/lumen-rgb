import { Gauge, Info, Shuffle, Sun } from 'lucide-react';

import { COLOR_MODE, type Assignment, type Device, type RGB } from '@shared/types';
import {
  LabeledSlider,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@renderer/components/ui';
import { Section } from '@renderer/components/common/Section';
import { ColorArea } from '@renderer/components/color/ColorArea';
import { ColorList } from '@renderer/components/color/ColorList';
import { DirectionControl } from './DirectionControl';
import {
  directionOptions,
  modeHasBrightness,
  modeHasSpeed,
  modeIsMultiColor,
  modeIsRandomColor,
  modeSummary,
  modeUsesColors,
  toPercent,
} from '@renderer/lib/modes';

export interface HardwareModePanelProps {
  device: Device;
  /** Atribuicao atual — garantidamente do tipo `hardware`. */
  assignment: Extract<Assignment, { mode: 'hardware' }>;
  onChange: (assignment: Assignment) => void;
  recentColors: RGB[];
  onCommitColor: (color: RGB) => void;
  disabled?: boolean;
}

/**
 * Controles dos modos gravados no proprio hardware.
 *
 * Cada controle aparece somente quando o modo escolhido declara suporte
 * a ele (flags `MODE_FLAG_*`) — nunca uma parede de sliders apagados.
 */
export function HardwareModePanel({
  device,
  assignment,
  onChange,
  recentColors,
  onCommitColor,
  disabled,
}: HardwareModePanelProps) {
  const mode = device.modes[assignment.modeIndex] ?? device.modes[0];

  if (!mode) {
    return (
      <p className="text-sm leading-relaxed text-muted-foreground">
        Este device nao reportou nenhum modo de iluminacao.
      </p>
    );
  }

  const patch = (next: Partial<Extract<Assignment, { mode: 'hardware' }>>): void => {
    onChange({ ...assignment, ...next });
  };

  const selectMode = (index: number): void => {
    const target = device.modes[index];
    if (!target) return;

    // Troca de modo reinicia os parametros para o que o modo declara,
    // preservando as cores que couberem.
    onChange({
      mode: 'hardware',
      modeIndex: index,
      colors: target.colors.length
        ? target.colors
        : assignment.colors.slice(0, Math.max(target.colorsMin, 1)),
      speed: target.speed?.current,
      brightness: target.brightness?.current,
      direction: target.direction,
    });
  };

  const directions = directionOptions(mode);
  const singleColor = modeUsesColors(mode) && !modeIsMultiColor(mode) && !modeIsRandomColor(mode);
  const multiColor = modeIsMultiColor(mode) && !modeIsRandomColor(mode);
  const currentColor: RGB = assignment.colors[0] ?? { r: 255, g: 255, b: 255 };

  return (
    <div className="flex flex-col gap-10">
      <Section
        title="Modo do hardware"
        description="Estes modos rodam dentro do proprio device e continuam funcionando mesmo com o Lumen fechado."
      >
        <Select
          value={String(assignment.modeIndex)}
          onValueChange={(value) => selectMode(Number(value))}
          disabled={disabled}
        >
          <SelectTrigger aria-label="Modo do hardware" className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {device.modes.map((item) => (
              <SelectItem key={item.index} value={String(item.index)}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <p className="flex items-start gap-2 text-xs leading-relaxed text-subtle-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {modeSummary(mode)}
        </p>
      </Section>

      {modeIsRandomColor(mode) ? (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          <Shuffle className="mt-0.5 size-4 shrink-0" aria-hidden />
          Este modo escolhe as cores sozinho — nao ha nada para ajustar aqui.
        </p>
      ) : null}

      {mode.colorMode === COLOR_MODE.NONE && !modeIsRandomColor(mode) ? (
        <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
          Este modo usa uma sequencia fixa de cores definida pelo fabricante.
        </p>
      ) : null}

      {singleColor ? (
        <Section title="Cor">
          <ColorArea
            color={currentColor}
            disabled={disabled}
            recentColors={recentColors}
            onChange={(color) => patch({ colors: [color] })}
            onCommit={onCommitColor}
          />
        </Section>
      ) : null}

      {multiColor ? (
        <Section
          title="Cores"
          description={`Este modo aceita de ${mode.colorsMin} a ${mode.colorsMax} cores.`}
        >
          <ColorList
            colors={assignment.colors.length ? assignment.colors : [currentColor]}
            min={mode.colorsMin}
            max={mode.colorsMax}
            disabled={disabled}
            recentColors={recentColors}
            onCommitColor={onCommitColor}
            onChange={(colors) => patch({ colors })}
            className="max-w-md"
          />
        </Section>
      ) : null}

      {modeHasSpeed(mode) || modeHasBrightness(mode) || directions.length > 0 ? (
        <Section title="Ajustes">
          <div className="flex max-w-md flex-col gap-6">
            {modeHasSpeed(mode) && mode.speed ? (
              <LabeledSlider
                label="Velocidade"
                icon={<Gauge className="size-3.5 text-muted-foreground" aria-hidden />}
                valueLabel={`${toPercent(assignment.speed ?? mode.speed.current, mode.speed.min, mode.speed.max)}%`}
                min={mode.speed.min}
                max={mode.speed.max}
                step={1}
                disabled={disabled}
                value={[assignment.speed ?? mode.speed.current]}
                onValueChange={([value]) => patch({ speed: value })}
              />
            ) : null}

            {modeHasBrightness(mode) && mode.brightness ? (
              <LabeledSlider
                label="Brilho"
                icon={<Sun className="size-3.5 text-muted-foreground" aria-hidden />}
                valueLabel={`${toPercent(assignment.brightness ?? mode.brightness.current, mode.brightness.min, mode.brightness.max)}%`}
                min={mode.brightness.min}
                max={mode.brightness.max}
                step={1}
                disabled={disabled}
                value={[assignment.brightness ?? mode.brightness.current]}
                onValueChange={([value]) => patch({ brightness: value })}
              />
            ) : null}

            {directions.length > 0 ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-foreground">Direcao</span>
                <DirectionControl
                  options={directions}
                  value={assignment.direction ?? mode.direction}
                  disabled={disabled}
                  onChange={(value) => patch({ direction: value })}
                />
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

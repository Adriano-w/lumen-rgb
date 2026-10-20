import { ArrowLeftRight, Gauge, Ruler, Sun } from 'lucide-react';

import type { Assignment, EffectKind, RGB } from '@shared/types';
import { LabeledSlider } from '@renderer/components/ui';
import { Section } from '@renderer/components/common/Section';
import { ColorArea } from '@renderer/components/color/ColorArea';
import { ColorList } from '@renderer/components/color/ColorList';
import { EffectCard } from '@renderer/components/effects/EffectCard';
import { EFFECT_LIST, clampColors, effectUi, initialParams, type EffectUi } from '@renderer/lib/effects';
import { cn, formatLeds } from '@renderer/lib/utils';

export interface LumenEffectsPanelProps {
  /** Atribuicao atual — garantidamente do tipo `lumen`. */
  assignment: Extract<Assignment, { mode: 'lumen' }>;
  onChange: (assignment: Assignment) => void;
  /** LEDs cobertos pelo alvo atual; efeitos espaciais precisam de 2+. */
  targetLeds: number;
  recentColors: RGB[];
  onCommitColor: (color: RGB) => void;
  disabled?: boolean;
}

/**
 * Controles dos efeitos do nosso motor.
 *
 * Tudo que aparece aqui vem do `EffectDescriptor` do efeito escolhido:
 * sem `usesSpeed` nao existe slider de velocidade, sem `usesDirection`
 * nao existe controle de sentido, e com `maxColors === 0` a paleta nem e
 * desenhada. Trocar de efeito troca o conjunto de controles.
 */
export function LumenEffectsPanel({
  assignment,
  onChange,
  targetLeds,
  recentColors,
  onCommitColor,
  disabled,
}: LumenEffectsPanelProps) {
  const { kind, params } = assignment.effect;
  const ui = effectUi(kind);
  const { descriptor } = ui;

  const patchParams = (next: Partial<typeof params>): void => {
    onChange({ mode: 'lumen', effect: { kind, params: { ...params, ...next } } });
  };

  const selectEffect = (nextKind: EffectKind): void => {
    onChange({
      mode: 'lumen',
      effect: { kind: nextKind, params: initialParams(nextKind, params.colors) },
    });
  };

  /** Por que este efeito nao pode ser escolhido agora (ou `undefined`). */
  const blockedReason = (effect: EffectUi): string | undefined => {
    if (!effect.available) {
      return 'Este efeito precisa capturar audio ou imagem da tela, e isso ainda nao esta pronto nesta versao do Lumen.';
    }
    if (effect.spatial && targetLeds < 2) {
      return `O alvo escolhido tem ${formatLeds(targetLeds)}, e este efeito precisa de pelo menos 2 para ter o que mostrar.`;
    }
    return undefined;
  };

  const colors = clampColors(kind, params.colors);
  const showSpread = descriptor.usesSpread && targetLeds > 1;
  const showDirection = descriptor.usesDirection && targetLeds > 1;

  return (
    <div className="flex flex-col gap-10">
      <Section
        title="Efeito"
        description="Estes efeitos sao calculados pelo Lumen e enviados quadro a quadro — eles param quando o app fecha."
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
          {EFFECT_LIST.map((effect) => (
            <EffectCard
              key={effect.descriptor.kind}
              effect={effect}
              selected={effect.descriptor.kind === kind}
              colors={colors}
              blockedReason={blockedReason(effect)}
              onSelect={() => selectEffect(effect.descriptor.kind)}
            />
          ))}
        </div>
      </Section>

      {/* Paleta: existe so quando o efeito consome cores. */}
      {ui.usesPalette ? (
        <Section
          title={descriptor.maxColors > 1 ? 'Cores' : 'Cor'}
          description={
            ui.paletteOptional
              ? `Opcional: sem nenhuma cor, o efeito percorre o espectro inteiro. Com cores, ele usa so elas (ate ${descriptor.maxColors}).`
              : descriptor.maxColors > 1
                ? `Use de ${descriptor.minColors} a ${descriptor.maxColors} cores — o efeito distribui elas pelos LEDs.`
                : undefined
          }
        >
          {descriptor.maxColors > 1 ? (
            <ColorList
              colors={colors}
              min={descriptor.minColors}
              max={descriptor.maxColors}
              disabled={disabled}
              recentColors={recentColors}
              onCommitColor={onCommitColor}
              onChange={(next) => patchParams({ colors: next })}
              className="max-w-md"
            />
          ) : (
            <ColorArea
              color={colors[0] ?? { r: 255, g: 255, b: 255 }}
              disabled={disabled}
              recentColors={recentColors}
              onChange={(color) => patchParams({ colors: [color] })}
              onCommit={onCommitColor}
            />
          )}
        </Section>
      ) : null}

      <Section title="Ajustes">
        <div className="flex max-w-md flex-col gap-6">
          {/* Brilho vale para qualquer efeito: e multiplicador de saida. */}
          <LabeledSlider
            label="Brilho"
            icon={<Sun className="size-3.5 text-muted-foreground" aria-hidden />}
            valueLabel={`${params.brightness}%`}
            min={0}
            max={100}
            step={1}
            disabled={disabled}
            value={[params.brightness]}
            onValueChange={([value]) => patchParams({ brightness: value })}
          />

          {descriptor.usesSpeed ? (
            <LabeledSlider
              label="Velocidade"
              icon={<Gauge className="size-3.5 text-muted-foreground" aria-hidden />}
              valueLabel={`${params.speed}%`}
              min={0}
              max={100}
              step={1}
              disabled={disabled}
              value={[params.speed]}
              onValueChange={([value]) => patchParams({ speed: value })}
            />
          ) : null}

          {showSpread ? (
            <LabeledSlider
              label="Comprimento da onda"
              icon={<Ruler className="size-3.5 text-muted-foreground" aria-hidden />}
              valueLabel={formatLeds(params.spread)}
              hint="Quantos LEDs um ciclo completo do efeito ocupa."
              min={2}
              max={Math.max(8, targetLeds * 2)}
              step={1}
              disabled={disabled}
              value={[params.spread]}
              onValueChange={([value]) => patchParams({ spread: value })}
            />
          ) : null}

          {showDirection ? (
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                <ArrowLeftRight className="size-3.5 text-muted-foreground" aria-hidden />
                Sentido
              </span>
              <div
                role="radiogroup"
                aria-label="Sentido do efeito"
                className="inline-flex w-fit items-center gap-1 rounded-lg border border-border bg-surface-2 p-1"
              >
                {(['forward', 'reverse'] as const).map((direction) => (
                  <button
                    key={direction}
                    type="button"
                    role="radio"
                    aria-checked={params.direction === direction}
                    disabled={disabled}
                    onClick={() => patchParams({ direction })}
                    className={cn(
                      'h-8 rounded-md px-3.5 text-xs font-medium transition-colors',
                      'outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
                      'disabled:pointer-events-none disabled:opacity-45',
                      params.direction === direction
                        ? 'bg-card text-foreground shadow-soft'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {direction === 'forward' ? 'Para frente' : 'Para tras'}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

        </div>
      </Section>
    </div>
  );
}

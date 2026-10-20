import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftRight,
  CircleAlert,
  CircleCheck,
  Gauge,
  Info,
  Layers,
  LoaderCircle,
  RefreshCw,
  Ruler,
  SearchX,
  Sparkles,
  Sun,
  TriangleAlert,
  X,
} from 'lucide-react';

import {
  DEFAULT_EFFECT_PARAMS,
  type Assignment,
  type Device,
  type EffectKind,
  type EffectParams,
  type RGB,
} from '@shared/types';

import { Button, LabeledSlider, ScrollArea } from '@renderer/components/ui';
import { EmptyState } from '@renderer/components/common/EmptyState';
import { Notice } from '@renderer/components/common/Notice';
import { Section } from '@renderer/components/common/Section';
import { ColorArea } from '@renderer/components/color/ColorArea';
import { ColorList } from '@renderer/components/color/ColorList';
import { EffectCard } from '@renderer/components/effects/EffectCard';
import {
  BULK_EFFECTS,
  DEFAULT_BULK_EFFECT,
  bulkAssignment,
  formatDevices,
  isMovingEffect,
  joinNames,
  singleColor,
  type BulkMode,
} from '@renderer/lib/bulk';
import { deviceLabel } from '@renderer/lib/devices';
import { clampColors, effectUi, initialParams, type EffectUi } from '@renderer/lib/effects';
import { cn, formatLeds } from '@renderer/lib/utils';
import type { BulkProgress, BulkResult } from '@renderer/store';

import { BulkModeToggle } from './BulkModeToggle';
import { DeviceChecklist } from './DeviceChecklist';

export interface AllDevicesViewProps {
  devices: Device[];
  recentColors: RGB[];
  onCommitColor: (color: RGB) => void;
  /** Backend fora do ar: os controles aparecem, mas nao escrevem nada. */
  offline: boolean;
  /** Aplica device a device, na ordem — nunca em paralelo. */
  onApply: (deviceIds: string[], assignment: Assignment, skippedIds: string[]) => void;
  progress: BulkProgress | null;
  result: BulkResult | null;
  onDismissResult: () => void;
  busy: boolean;
  onRescan: () => void;
  rescanning: boolean;
  /** Leva para a tela daquele device, para usar os modos do hardware. */
  onOpenDevice: (deviceId: string) => void;
}

/**
 * Tela "Todos os devices": uma escolha so, aplicada a varios.
 *
 * O argumento dela e a sincronia. Os efeitos do Lumen saem todos do mesmo
 * relogio, dentro do app, entao eles ficam realmente em fase entre os
 * devices. Modos gravados no firmware nao tem como: cada controlador conta
 * o tempo no proprio cristal, e eles sempre derivam um do outro.
 */
export function AllDevicesView({
  devices,
  recentColors,
  onCommitColor,
  offline,
  onApply,
  progress,
  result,
  onDismissResult,
  busy,
  onRescan,
  rescanning,
  onOpenDevice,
}: AllDevicesViewProps) {
  /* --- Selecao --- */
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    devices.filter((device) => device.supportsDirect).map((device) => device.id),
  );

  // Device que sumiu numa redeteccao nao pode continuar selecionado.
  useEffect(() => {
    setSelectedIds((current) => {
      const alive = current.filter((id) => devices.some((device) => device.id === id));
      return alive.length === current.length ? current : alive;
    });
  }, [devices]);

  /* --- O que aplicar --- */
  const [mode, setMode] = useState<BulkMode>('effect');
  const [effectKind, setEffectKind] = useState<EffectKind>(DEFAULT_BULK_EFFECT);
  const [params, setParams] = useState<EffectParams>(() =>
    initialParams(DEFAULT_BULK_EFFECT, DEFAULT_EFFECT_PARAMS.colors),
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selected = useMemo(
    () => devices.filter((device) => selectedSet.has(device.id)),
    [devices, selectedSet],
  );

  // Tudo nesta tela e efeito do nosso motor, entao quem nao tem modo
  // Direct nao tem como receber — nem a cor fixa, nem o desligar.
  const eligible = useMemo(() => selected.filter((device) => device.supportsDirect), [selected]);
  const ignored = useMemo(() => selected.filter((device) => !device.supportsDirect), [selected]);

  const maxLeds = useMemo(() => {
    const pool = eligible.length > 0 ? eligible : devices;
    return pool.reduce((max, device) => Math.max(max, device.ledCount), 0);
  }, [eligible, devices]);

  const ui = effectUi(effectKind);
  const { descriptor } = ui;
  const colors = clampColors(effectKind, params.colors);

  const patchParams = (next: Partial<EffectParams>): void => {
    setParams((current) => ({ ...current, ...next }));
  };

  const selectEffect = (nextKind: EffectKind): void => {
    setEffectKind(nextKind);
    setParams((current) => initialParams(nextKind, current.colors));
  };

  /** Por que este efeito nao pode ser escolhido agora (ou `undefined`). */
  const blockedReason = (effect: EffectUi): string | undefined => {
    if (!effect.available) {
      return 'Este efeito precisa capturar audio ou imagem da tela, e isso ainda nao esta pronto nesta versao do Lumen.';
    }
    if (effect.spatial && maxLeds < 2) {
      return 'Este efeito espalha algo ao longo da fita, e nenhum dos devices escolhidos tem 2 LEDs ou mais para mostrar isso.';
    }
    return undefined;
  };

  const assignment = useMemo(
    () => bulkAssignment(mode, effectKind, params),
    [mode, effectKind, params],
  );

  const moving = mode === 'effect' && isMovingEffect(effectKind);
  const wearDevices = useMemo(
    () => eligible.filter((device) => device.writeWearRisk),
    [eligible],
  );

  const showSpread = mode === 'effect' && descriptor.usesSpread && maxLeds > 1;
  const showDirection = mode === 'effect' && descriptor.usesDirection && maxLeds > 1;
  const showPalette = mode === 'effect' && ui.usesPalette;

  // O efeito ja escolhido pode deixar de caber se o usuario desmarcar os
  // devices com mais LEDs — entao a checagem vale para ele tambem.
  const currentBlocked = mode === 'effect' ? blockedReason(ui) : undefined;

  const allSelected = devices.length > 0 && selectedIds.length === devices.length;
  const canApply = !offline && !busy && eligible.length > 0 && !currentBlocked;

  const toggleDevice = (deviceId: string, next: boolean): void => {
    setSelectedIds((current) =>
      next ? [...current, deviceId] : current.filter((id) => id !== deviceId),
    );
  };

  const handleApply = (): void => {
    onApply(
      eligible.map((device) => device.id),
      assignment,
      ignored.map((device) => device.id),
    );
  };

  /* --- Estado: nenhum device --- */
  if (devices.length === 0) {
    return (
      <EmptyState
        icon={SearchX}
        title="Nenhum device para controlar"
        description="Esta tela aplica uma mesma iluminacao em varios devices de uma vez, mas o Lumen ainda nao encontrou nenhum. Placa-mae e memoria RAM precisam do driver PawnIO e do Lumen rodando como administrador."
        action={
          <Button variant="primary" onClick={onRescan} disabled={rescanning}>
            <RefreshCw className={cn(rescanning && 'animate-spin')} aria-hidden />
            {rescanning ? 'Procurando...' : 'Procurar de novo'}
          </Button>
        }
      />
    );
  }

  return (
    <ScrollArea className="flex-1" viewportClassName="px-8 pb-12 pt-6">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
        {/* Cabecalho */}
        <header className="flex items-start gap-4">
          <span
            className="flex size-12 shrink-0 items-center justify-center rounded-lg border border-primary/35 bg-primary-soft text-primary"
            aria-hidden
          >
            <Layers className="size-5" />
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              Todos os devices
            </h1>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              Uma escolha so, aplicada em varios devices ao mesmo tempo. Os efeitos do Lumen saem
              todos do mesmo relogio aqui dentro, entao eles ficam de verdade em sincronia — os
              modos gravados no hardware nao conseguem isso, porque cada controlador conta o tempo
              por conta propria.
            </p>
          </div>
        </header>

        {/* Quem recebe */}
        <Section
          title="Devices"
          description={
            selectedIds.length === 0
              ? 'Marque quem vai receber a iluminacao.'
              : `${formatDevices(selectedIds.length)} de ${devices.length} selecionados.`
          }
          aside={
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={allSelected || busy}
                onClick={() => setSelectedIds(devices.map((device) => device.id))}
              >
                Selecionar todos
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={selectedIds.length === 0 || busy}
                onClick={() => setSelectedIds([])}
              >
                Limpar selecao
              </Button>
            </div>
          }
        >
          <DeviceChecklist
            devices={devices}
            selectedIds={selectedSet}
            onToggle={toggleDevice}
            disabled={busy}
          />
        </Section>

        {/* O que aplicar */}
        <Section title="O que aplicar">
          <BulkModeToggle value={mode} onChange={setMode} disabled={busy} />
        </Section>

        {/* Efeito do Lumen */}
        {mode === 'effect' ? (
          <Section
            title="Efeito"
            description="Calculado pelo Lumen e enviado quadro a quadro, do mesmo relogio para todos os devices escolhidos. Para quando o app fecha."
          >
            <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
              {BULK_EFFECTS.map((effect) => (
                <EffectCard
                  key={effect.descriptor.kind}
                  effect={effect}
                  selected={effect.descriptor.kind === effectKind}
                  colors={colors}
                  blockedReason={blockedReason(effect)}
                  onSelect={() => selectEffect(effect.descriptor.kind)}
                />
              ))}
            </div>
          </Section>
        ) : null}

        {/* Cor fixa */}
        {mode === 'color' ? (
          <Section title="Cor" description="Essa cor vai para todos os devices escolhidos.">
            <ColorArea
              color={singleColor(params)}
              disabled={busy}
              recentColors={recentColors}
              onChange={(color) => patchParams({ colors: [color] })}
              onCommit={onCommitColor}
            />
          </Section>
        ) : null}

        {/* Paleta do efeito */}
        {showPalette ? (
          <Section
            title={descriptor.maxColors > 1 ? 'Cores' : 'Cor'}
            description={
              ui.paletteOptional
                ? `Opcional: sem nenhuma cor, o efeito percorre o espectro inteiro. Com cores, ele usa so elas (ate ${descriptor.maxColors}).`
                : descriptor.maxColors > 1
                  ? `Use de ${descriptor.minColors} a ${descriptor.maxColors} cores — o efeito distribui elas pelos LEDs de cada device.`
                  : undefined
            }
          >
            {descriptor.maxColors > 1 ? (
              <ColorList
                colors={colors}
                min={descriptor.minColors}
                max={descriptor.maxColors}
                disabled={busy}
                recentColors={recentColors}
                onCommitColor={onCommitColor}
                onChange={(next) => patchParams({ colors: next })}
                className="max-w-md"
              />
            ) : (
              <ColorArea
                color={colors[0] ?? singleColor(params)}
                disabled={busy}
                recentColors={recentColors}
                onChange={(color) => patchParams({ colors: [color] })}
                onCommit={onCommitColor}
              />
            )}
          </Section>
        ) : null}

        {/* Ajustes — so os que o efeito escolhido usa de verdade */}
        {mode !== 'off' ? (
          <Section title="Ajustes">
            <div className="flex max-w-md flex-col gap-6">
              <LabeledSlider
                label="Brilho"
                icon={<Sun className="size-3.5 text-muted-foreground" aria-hidden />}
                valueLabel={`${params.brightness}%`}
                min={0}
                max={100}
                step={1}
                disabled={busy}
                value={[params.brightness]}
                onValueChange={([value]) => patchParams({ brightness: value })}
              />

              {mode === 'effect' && descriptor.usesSpeed ? (
                <LabeledSlider
                  label="Velocidade"
                  icon={<Gauge className="size-3.5 text-muted-foreground" aria-hidden />}
                  valueLabel={`${params.speed}%`}
                  min={0}
                  max={100}
                  step={1}
                  disabled={busy}
                  value={[params.speed]}
                  onValueChange={([value]) => patchParams({ speed: value })}
                />
              ) : null}

              {showSpread ? (
                <LabeledSlider
                  label="Comprimento da onda"
                  icon={<Ruler className="size-3.5 text-muted-foreground" aria-hidden />}
                  valueLabel={formatLeds(params.spread)}
                  hint="Quantos LEDs um ciclo completo do efeito ocupa em cada device."
                  min={2}
                  max={Math.max(8, maxLeds * 2)}
                  step={1}
                  disabled={busy}
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
                        disabled={busy}
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
        ) : null}

        {/* Consequencias e resultado */}
        <div className="flex flex-col gap-4 border-t border-border pt-6">
          {/* Selecao mista: device sem modo Direct nao recebe nada daqui. */}
          {ignored.length > 0 ? (
            <Notice
              tone="warning"
              icon={TriangleAlert}
              title={
                ignored.length === 1
                  ? `${deviceLabel(ignored[0])} vai ficar de fora`
                  : `${formatDevices(ignored.length)} vao ficar de fora`
              }
              action={
                ignored.length === 1 ? (
                  <Button variant="outline" size="sm" onClick={() => onOpenDevice(ignored[0].id)}>
                    Abrir device
                  </Button>
                ) : undefined
              }
            >
              <p>
                {joinNames(ignored.map(deviceLabel))}{' '}
                {ignored.length === 1 ? 'nao expoe' : 'nao expoem'} modo Direct, entao o Lumen nao
                consegue pintar LED a LED {ignored.length === 1 ? 'nele' : 'neles'} — nem com
                efeito, nem com cor fixa. Abra {ignored.length === 1 ? 'ele' : 'cada um'} na lista a
                esquerda para usar os modos gravados no proprio hardware.
              </p>
            </Notice>
          ) : null}

          {/* O efeito atual nao cabe mais na selecao. */}
          {currentBlocked ? (
            <Notice
              tone="warning"
              icon={TriangleAlert}
              title={`"${descriptor.label}" nao cabe nos devices escolhidos`}
            >
              <p>{currentBlocked}</p>
            </Notice>
          ) : null}

          {/* Desgaste de flash: avisa, mas nao impede. */}
          {moving && wearDevices.length > 0 ? (
            <Notice tone="info" icon={Info} title="Ritmo reduzido para proteger a memoria">
              <p>
                {joinNames(wearDevices.map(deviceLabel))}{' '}
                {wearDevices.length === 1 ? 'grava' : 'gravam'} cada mudanca de cor na memoria
                interna do controlador, que tem um numero finito de gravacoes. O efeito roda normal,
                so que com menos quadros por segundo{' '}
                {wearDevices.length === 1 ? 'nesse device' : 'nesses devices'}. Os outros continuam
                na taxa cheia.
              </p>
            </Notice>
          ) : null}

          {/* Em andamento */}
          {progress ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 p-3.5"
            >
              <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
              <p className="text-sm leading-snug text-foreground">
                Aplicando {Math.min(progress.done + 1, progress.total)} de {progress.total}...{' '}
                <span className="text-muted-foreground">{progress.currentName}</span>
              </p>
            </div>
          ) : null}

          {/* Resultado */}
          {result && !progress ? (
            <BulkResultNotice result={result} onDismiss={onDismissResult} />
          ) : null}

          {/* Acao principal */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
              {offline
                ? 'O servico do Lumen esta fora do ar, entao nada sera escrito ate ele voltar.'
                : selectedIds.length === 0
                  ? 'Marque pelo menos um device para poder aplicar.'
                  : eligible.length === 0
                    ? 'Nenhum dos devices marcados aceita efeitos do Lumen.'
                    : 'O Lumen escreve um device por vez, na ordem da lista, para nao disputar o barramento.'}
            </p>

            <Button
              variant="primary"
              size="lg"
              className="shrink-0"
              disabled={!canApply}
              onClick={handleApply}
            >
              {busy ? (
                <LoaderCircle className="animate-spin" aria-hidden />
              ) : (
                <Sparkles aria-hidden />
              )}
              {busy
                ? 'Aplicando...'
                : eligible.length === 0
                  ? 'Aplicar'
                  : `Aplicar a ${formatDevices(eligible.length)}`}
            </Button>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

interface BulkResultNoticeProps {
  result: BulkResult;
  onDismiss: () => void;
}

/**
 * O que aconteceu de fato.
 *
 * Sucesso parcial nao vira "pronto!": a tela nomeia cada device que
 * recusou o comando e o motivo que o backend devolveu.
 */
function BulkResultNotice({ result, onDismiss }: BulkResultNoticeProps) {
  const { applied, failed, skipped } = result;
  if (applied.length === 0 && failed.length === 0 && skipped.length === 0) return null;

  const tone = failed.length === 0 ? 'success' : applied.length === 0 ? 'danger' : 'warning';
  const icon = failed.length === 0 ? CircleCheck : applied.length === 0 ? CircleAlert : TriangleAlert;

  const title =
    failed.length === 0
      ? `Aplicado em ${formatDevices(applied.length)}`
      : applied.length === 0
        ? 'Nenhum device aceitou o comando'
        : `Aplicado em ${applied.length} de ${applied.length + failed.length} devices`;

  return (
    <Notice
      tone={tone}
      icon={icon}
      title={title}
      action={
        <Button variant="ghost" size="icon-sm" aria-label="Fechar resultado" onClick={onDismiss}>
          <X />
        </Button>
      }
    >
      {failed.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {failed.map((failure) => (
            <li key={failure.deviceId} className="leading-snug">
              <span className="font-medium text-foreground">{failure.name}</span> — {failure.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {skipped.length > 0 ? (
        <p className={cn('leading-snug', failed.length > 0 && 'mt-1.5')}>
          Fora da conta: {joinNames(skipped)} (sem modo Direct).
        </p>
      ) : null}
    </Notice>
  );
}

import { useEffect, useState } from 'react';
import { CircleX, LoaderCircle, PlugZap, RefreshCw, SearchX, X } from 'lucide-react';

import type { Assignment, TargetRef } from '@shared/types';

import { Button, TooltipProvider } from '@renderer/components/ui';
import { EmptyState } from '@renderer/components/common/EmptyState';
import { DiagnosticsBanner } from '@renderer/components/layout/DiagnosticsBanner';
import { Sidebar } from '@renderer/components/layout/Sidebar';
import { TopBar } from '@renderer/components/layout/TopBar';
import { AllDevicesView } from '@renderer/components/all-devices/AllDevicesView';
import { DeviceDetail } from '@renderer/components/device/DeviceDetail';
import { ProfilesDialog } from '@renderer/components/profiles/ProfilesDialog';
import { SettingsDialog } from '@renderer/components/settings/SettingsDialog';

import { isMockBackend } from '@renderer/lib/api';
import { useThemeSync } from '@renderer/hooks/useThemeSync';
import { useAssignmentFor, useLumenStore, useSelectedDevice } from '@renderer/store';

export default function App() {
  const phase = useLumenStore((state) => state.phase);
  const errorMessage = useLumenStore((state) => state.errorMessage);
  const dismissError = useLumenStore((state) => state.dismissError);

  const devices = useLumenStore((state) => state.devices);
  const status = useLumenStore((state) => state.status);
  const diagnostics = useLumenStore((state) => state.diagnostics);
  const profiles = useLumenStore((state) => state.profiles);
  const settings = useLumenStore((state) => state.settings);

  const view = useLumenStore((state) => state.view);
  const selectedDeviceId = useLumenStore((state) => state.selectedDeviceId);
  const selectedZoneIndex = useLumenStore((state) => state.selectedZoneIndex);
  const bulkProgress = useLumenStore((state) => state.bulkProgress);
  const bulkResult = useLumenStore((state) => state.bulkResult);
  const recentColors = useLumenStore((state) => state.recentColors);
  const globalBrightness = useLumenStore((state) => state.globalBrightness);
  const activeProfileId = useLumenStore((state) => state.activeProfileId);

  const rescanning = useLumenStore((state) => state.busy.rescan ?? false);
  const turningOff = useLumenStore((state) => state.busy.applyAll ?? false);
  const profileBusy = useLumenStore((state) => state.busy.profile ?? false);
  const bulkBusy = useLumenStore((state) => state.busy.bulk ?? false);

  const bootstrap = useLumenStore((state) => state.bootstrap);
  const rescan = useLumenStore((state) => state.rescan);
  const selectDevice = useLumenStore((state) => state.selectDevice);
  const selectZone = useLumenStore((state) => state.selectZone);
  const showAllDevices = useLumenStore((state) => state.showAllDevices);
  const applyAssignment = useLumenStore((state) => state.applyAssignment);
  const applyToDevices = useLumenStore((state) => state.applyToDevices);
  const clearBulkResult = useLumenStore((state) => state.clearBulkResult);
  const setGlobalBrightness = useLumenStore((state) => state.setGlobalBrightness);
  const commitGlobalBrightness = useLumenStore((state) => state.commitGlobalBrightness);
  const turnEverythingOff = useLumenStore((state) => state.turnEverythingOff);
  const pushRecentColor = useLumenStore((state) => state.pushRecentColor);
  const saveCurrentProfile = useLumenStore((state) => state.saveCurrentProfile);
  const applyProfile = useLumenStore((state) => state.applyProfile);
  const renameProfile = useLumenStore((state) => state.renameProfile);
  const removeProfile = useLumenStore((state) => state.removeProfile);
  const reorderProfiles = useLumenStore((state) => state.reorderProfiles);
  const updateSettings = useLumenStore((state) => state.updateSettings);

  const device = useSelectedDevice();
  const storedAssignment = useAssignmentFor(selectedDeviceId, selectedZoneIndex);

  const [profilesOpen, setProfilesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useThemeSync(settings.theme);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const offline = status !== null && status.state !== 'connected';
  const disconnectedReason =
    status?.state === 'disconnected'
      ? status.reason
      : status?.state === 'error'
        ? (status.hint ?? status.reason)
        : undefined;

  const handleApply = (target: TargetRef, assignment: Assignment): void => {
    void applyAssignment(target, assignment);
  };

  /* --- Estado: carregando --- */
  if (phase === 'loading') {
    return (
      <TooltipProvider delayDuration={400}>
        <main className="flex h-full items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-4">
            <LoaderCircle className="size-6 animate-spin text-primary" aria-hidden />
            <p className="text-sm text-muted-foreground">Procurando sua iluminacao...</p>
          </div>
        </main>
      </TooltipProvider>
    );
  }

  /* --- Estado: nao deu para falar com o backend --- */
  if (phase === 'error') {
    return (
      <TooltipProvider delayDuration={400}>
        <main className="flex h-full bg-background">
          <EmptyState
            icon={PlugZap}
            tone="danger"
            title="Nao conseguimos falar com o servico do Lumen"
            description={`O app abriu, mas o servico que conversa com o hardware nao respondeu.${errorMessage ? ` Detalhe tecnico: ${errorMessage}` : ''} Isso costuma acontecer quando o Lumen foi aberto sem permissao de administrador.`}
            action={
              <Button variant="primary" onClick={() => void bootstrap()}>
                <RefreshCw aria-hidden />
                Tentar de novo
              </Button>
            }
          />
        </main>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full bg-background">
        <Sidebar
          devices={devices}
          selectedDeviceId={selectedDeviceId}
          view={view}
          onSelect={selectDevice}
          onShowAll={showAllDevices}
          onRescan={() => void rescan()}
          rescanning={rescanning}
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar
            status={status}
            brightness={globalBrightness}
            onBrightnessChange={setGlobalBrightness}
            onBrightnessCommit={() => void commitGlobalBrightness()}
            onTurnOff={() => void turnEverythingOff()}
            turningOff={turningOff}
            profiles={profiles}
            activeProfileId={activeProfileId}
            onApplyProfile={(id) => void applyProfile(id)}
            onOpenProfiles={() => setProfilesOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            mockBackend={isMockBackend}
          />

          <DiagnosticsBanner
            diagnostics={diagnostics}
            disconnectedReason={disconnectedReason}
            onRescan={() => void rescan()}
          />

          {view === 'all' ? (
            <AllDevicesView
              devices={devices}
              recentColors={recentColors}
              onCommitColor={pushRecentColor}
              offline={offline}
              onApply={(deviceIds, assignment, skippedIds) =>
                void applyToDevices(deviceIds, assignment, skippedIds)
              }
              progress={bulkProgress}
              result={bulkResult}
              onDismissResult={clearBulkResult}
              busy={bulkBusy}
              onRescan={() => void rescan()}
              rescanning={rescanning}
              onOpenDevice={selectDevice}
            />
          ) : devices.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="Nenhum device com RGB encontrado"
              description="O Lumen varreu o barramento e nao achou nada controlavel. Placa-mae e memoria RAM precisam do driver PawnIO instalado e do Lumen rodando como administrador; perifericos USB costumam aparecer sozinhos."
              action={
                <Button variant="primary" onClick={() => void rescan()} disabled={rescanning}>
                  <RefreshCw className={rescanning ? 'animate-spin' : undefined} aria-hidden />
                  {rescanning ? 'Procurando...' : 'Procurar de novo'}
                </Button>
              }
            />
          ) : device ? (
            <DeviceDetail
              key={device.id}
              device={device}
              zoneIndex={selectedZoneIndex}
              onZoneChange={selectZone}
              storedAssignment={storedAssignment}
              onApply={handleApply}
              recentColors={recentColors}
              onCommitColor={pushRecentColor}
              offline={offline}
              onSaveProfile={() => setProfilesOpen(true)}
            />
          ) : (
            <EmptyState
              icon={SearchX}
              title="Escolha um device"
              description="Selecione um item na lista a esquerda para ajustar a iluminacao dele."
            />
          )}
        </main>

        {/* Aviso de erro de acao — nao bloqueia a tela */}
        {errorMessage ? (
          <div
            role="alert"
            className="fixed bottom-6 left-1/2 z-50 flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-lg border border-destructive/35 bg-card px-4 py-3 shadow-overlay"
          >
            <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <p className="text-sm leading-relaxed text-foreground">
              Esse comando nao foi aplicado. {errorMessage}
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Fechar aviso"
              onClick={dismissError}
              className="-mr-1 -mt-1"
            >
              <X />
            </Button>
          </div>
        ) : null}

        <ProfilesDialog
          open={profilesOpen}
          onOpenChange={setProfilesOpen}
          profiles={profiles}
          activeProfileId={activeProfileId}
          busy={profileBusy}
          onApply={(id) => void applyProfile(id)}
          onRename={(id, name) => void renameProfile(id, name)}
          onDelete={(id) => void removeProfile(id)}
          onReorder={reorderProfiles}
          onSaveCurrent={(name) => void saveCurrentProfile(name)}
        />

        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          settings={settings}
          profiles={profiles}
          conflictingProcesses={diagnostics?.conflictingProcesses ?? []}
          onChange={(patch) => void updateSettings(patch)}
        />
      </div>
    </TooltipProvider>
  );
}

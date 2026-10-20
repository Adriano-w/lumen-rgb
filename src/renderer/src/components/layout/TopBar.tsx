import { Power, Settings as SettingsIcon, Sun } from 'lucide-react';

import type { EngineStatus, Profile } from '@shared/types';
import {
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Slider,
  Tooltip,
} from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';

const STATUS_LABEL: Record<EngineStatus['state'], { text: string; variant: 'success' | 'warning' | 'danger' | 'neutral' }> =
  {
    starting: { text: 'Iniciando', variant: 'neutral' },
    connected: { text: 'Conectado', variant: 'success' },
    disconnected: { text: 'Desconectado', variant: 'warning' },
    error: { text: 'Com erro', variant: 'danger' },
  };

/** Valores sentinela do Select de perfis. */
const MANAGE_PROFILES = '__manage__';
const NO_PROFILES = '__empty__';

export interface TopBarProps {
  status: EngineStatus | null;
  brightness: number;
  onBrightnessChange: (value: number) => void;
  onBrightnessCommit: () => void;
  onTurnOff: () => void;
  turningOff: boolean;
  profiles: Profile[];
  activeProfileId: string | null;
  onApplyProfile: (id: string) => void;
  onOpenProfiles: () => void;
  onOpenSettings: () => void;
  mockBackend: boolean;
}

export function TopBar({
  status,
  brightness,
  onBrightnessChange,
  onBrightnessCommit,
  onTurnOff,
  turningOff,
  profiles,
  activeProfileId,
  onApplyProfile,
  onOpenProfiles,
  onOpenSettings,
  mockBackend,
}: TopBarProps) {
  const statusInfo = STATUS_LABEL[status?.state ?? 'starting'];
  const offline = status?.state !== 'connected';

  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center gap-5 border-b border-border bg-surface-1/80 px-8 backdrop-blur">
      <div className="flex items-center gap-2">
        <Tooltip
          content={
            status?.state === 'error' || status?.state === 'disconnected'
              ? status.reason
              : status?.state === 'connected'
                ? `Protocolo ${status.protocolVersion} - servidor ${status.serverVersion}`
                : 'Conversando com o servico de iluminacao...'
          }
        >
          <Badge variant={statusInfo.variant} className="cursor-default">
            <span
              className={cn(
                'size-1.5 rounded-full',
                statusInfo.variant === 'success' && 'bg-success',
                statusInfo.variant === 'warning' && 'bg-warning',
                statusInfo.variant === 'danger' && 'bg-destructive',
                statusInfo.variant === 'neutral' && 'bg-muted-foreground animate-lumen-pulse',
              )}
              aria-hidden
            />
            {statusInfo.text}
          </Badge>
        </Tooltip>

        {mockBackend ? (
          <Tooltip content="O backend nao esta disponivel, entao a tela mostra devices de exemplo. Nada esta sendo enviado para hardware de verdade.">
            <Badge variant="info" className="cursor-default">
              Dados de exemplo
            </Badge>
          </Tooltip>
        ) : null}
      </div>

      <div className="flex-1" />

      {/* Brilho global */}
      <div className="flex w-56 items-center gap-3">
        <Sun className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Slider
          aria-label="Brilho geral"
          value={[brightness]}
          min={0}
          max={100}
          step={1}
          disabled={offline}
          onValueChange={([value]) => onBrightnessChange(value)}
          onValueCommit={onBrightnessCommit}
        />
        <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {brightness}%
        </span>
      </div>

      <span className="h-6 w-px bg-border" aria-hidden />

      {/* Perfis */}
      <Select
        value={activeProfileId ?? undefined}
        onValueChange={(value) => {
          if (value === MANAGE_PROFILES || value === NO_PROFILES) onOpenProfiles();
          else onApplyProfile(value);
        }}
      >
        <SelectTrigger aria-label="Perfil" className="w-48">
          <SelectValue placeholder="Escolher perfil" />
        </SelectTrigger>
        <SelectContent>
          {profiles.length === 0 ? (
            <SelectItem value={NO_PROFILES} disabled>
              Nenhum perfil salvo
            </SelectItem>
          ) : (
            <>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
              <SelectSeparator />
            </>
          )}
          <SelectItem value={MANAGE_PROFILES}>Gerenciar perfis...</SelectItem>
        </SelectContent>
      </Select>

      <Button variant="outline" onClick={onTurnOff} disabled={offline || turningOff}>
        <Power aria-hidden />
        Desligar tudo
      </Button>

      <Tooltip content="Configuracoes">
        <Button variant="ghost" size="icon" aria-label="Configuracoes" onClick={onOpenSettings}>
          <SettingsIcon />
        </Button>
      </Tooltip>
    </header>
  );
}

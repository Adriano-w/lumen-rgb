import { Monitor, Moon, Sun } from 'lucide-react';

import { type Profile, type Settings } from '@shared/types';
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LabeledSlider,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SwitchField,
} from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';

/** Sentinela do Select de perfil de inicializacao. */
const NO_BOOT_PROFILE = '__none__';

const THEMES: { value: Settings['theme']; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'system', label: 'Do sistema', icon: Monitor },
];

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  profiles: Profile[];
  /** Processos OEM detectados — muda o texto da ultima opcao. */
  conflictingProcesses: string[];
  onChange: (patch: Partial<Settings>) => void;
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  profiles,
  conflictingProcesses,
  onChange,
}: SettingsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configuracoes</DialogTitle>
          <DialogDescription>
            Tudo aqui e salvo na hora. Nao precisa confirmar.
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-8">
          {/* Inicializacao */}
          <section className="flex flex-col gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
              Ao ligar o computador
            </h3>

            <SwitchField
              label="Abrir junto com o Windows"
              description="O Lumen inicia sozinho e reaplica sua iluminacao, sem voce precisar abrir nada."
              checked={settings.launchOnLogin}
              onCheckedChange={(checked) => onChange({ launchOnLogin: checked })}
            />

            <SwitchField
              label="Comecar minimizado"
              description="A janela nao aparece no login; o Lumen fica na area de notificacao."
              checked={settings.startMinimized}
              disabled={!settings.launchOnLogin}
              onCheckedChange={(checked) => onChange({ startMinimized: checked })}
            />

            <div className="flex flex-col gap-2 pt-1">
              <label
                htmlFor="boot-profile"
                className="text-sm font-medium text-foreground"
              >
                Perfil aplicado no login
              </label>
              <Select
                value={settings.bootProfileId ?? NO_BOOT_PROFILE}
                onValueChange={(value) =>
                  onChange({ bootProfileId: value === NO_BOOT_PROFILE ? null : value })
                }
              >
                <SelectTrigger id="boot-profile">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_BOOT_PROFILE}>Nenhum — manter como estava</SelectItem>
                  {profiles.map((profile) => (
                    <SelectItem key={profile.id} value={profile.id}>
                      {profile.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {profiles.length === 0 ? (
                <p className="text-xs leading-relaxed text-subtle-foreground">
                  Voce ainda nao salvou nenhum perfil.
                </p>
              ) : null}
            </div>
          </section>

          {/* Aparencia */}
          <section className="flex flex-col gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
              Aparencia
            </h3>

            <div
              role="radiogroup"
              aria-label="Tema"
              className="grid grid-cols-3 gap-2"
            >
              {THEMES.map((theme) => {
                const Icon = theme.icon;
                const active = settings.theme === theme.value;

                return (
                  <button
                    key={theme.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => onChange({ theme: theme.value })}
                    className={cn(
                      'flex flex-col items-center gap-2 rounded-lg border px-3 py-3.5 transition-colors',
                      'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      active
                        ? 'border-primary bg-primary-soft/60 text-foreground'
                        : 'border-border bg-surface-2 text-muted-foreground hover:border-border-strong hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    <span className="text-xs font-medium">{theme.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Motor de efeitos */}
          <section className="flex flex-col gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
              Motor de efeitos
            </h3>

            <LabeledSlider
              label="Quadros por segundo"
              valueLabel={`${settings.effectFps} fps`}
              hint="Mais quadros deixam os efeitos mais suaves e usam um pouco mais de CPU. 30 e um bom equilibrio."
              min={10}
              max={120}
              step={5}
              value={[settings.effectFps]}
              onValueChange={([value]) => onChange({ effectFps: value })}
            />
          </section>

          {/* Conflitos */}
          <section className="flex flex-col gap-4">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-subtle-foreground">
              Software do fabricante
            </h3>

            <SwitchField
              label="Encerrar programas de RGB concorrentes ao iniciar"
              description={
                conflictingProcesses.length > 0
                  ? `Detectamos ${conflictingProcesses.join(', ')}. Esses programas disputam o mesmo barramento que o Lumen, e so um por vez consegue mandar comando.`
                  : 'Programas como Polychrome, iCUE ou Armoury Crate disputam o mesmo barramento que o Lumen. Com isso ligado, o Lumen fecha eles ao iniciar.'
              }
              checked={settings.stopConflictingSoftware}
              onCheckedChange={(checked) => onChange({ stopConflictingSoftware: checked })}
            />
          </section>
        </DialogBody>

        <DialogFooter>
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

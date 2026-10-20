/**
 * Icone de bandeja do Lumen.
 *
 * E o unico caminho para encerrar o app de verdade (o X da janela apenas
 * esconde). Todos os rotulos ficam em pt-BR.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import type { Profile } from '../shared/types.js';
import type { Engine } from './engine/engine.js';
import { createScopedLogger } from './logger.js';
import { getSettings, listProfiles, setSettings } from './store.js';
import { setQuitting, showWindow } from './window.js';

const log = createScopedLogger('tray');

const resolveFromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** Preto puro, usado pelo botao de panico "desligar todas as luzes". */
const BLACK = { r: 0, g: 0, b: 0 } as const;

function loadTrayImage(): NativeImage {
  const candidates = [
    resolveFromHere('../../resources/tray.png'),
    resolveFromHere('../../resources/icon.png'),
    resolveFromHere('../../../resources/tray.png'),
    resolveFromHere('../../../resources/icon.png'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 });
  }

  log.warn('Nenhum icone de bandeja encontrado em resources/; usando icone vazio.');
  return nativeImage.createEmpty();
}

export interface TrayController {
  /** Reconstroi o menu (apos mudanca de perfis ou de preferencias). */
  refresh(): void;
  /** Marca qual perfil aparece selecionado no menu. */
  setActiveProfile(id: string | null): void;
  destroy(): void;
}

export interface CreateTrayOptions {
  engine: Engine;
  /** Chamado apos gravar preferencias pela bandeja (para sincronizar a UI). */
  onSettingsChanged?: () => void;
}

export function createTray(options: CreateTrayOptions): TrayController {
  const { engine, onSettingsChanged } = options;

  const tray = new Tray(loadTrayImage());
  tray.setToolTip('Lumen — controle de iluminacao RGB');

  let activeProfileId: string | null = getSettings().bootProfileId;

  async function applyProfile(profile: Profile): Promise<void> {
    try {
      await engine.applyProfile(profile);
      activeProfileId = profile.id;
      build();
    } catch (error) {
      log.error(`Falha ao aplicar o perfil "${profile.name}".`, error);
    }
  }

  async function turnEverythingOff(): Promise<void> {
    try {
      await engine.applyAll({
        mode: 'lumen',
        effect: {
          kind: 'static',
          params: { colors: [BLACK], speed: 0, brightness: 0, direction: 'forward', spread: 1 },
        },
      });
      activeProfileId = null;
      build();
    } catch (error) {
      log.error('Falha ao desligar as luzes.', error);
    }
  }

  function buildProfileItems(): MenuItemConstructorOptions[] {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      return [{ label: 'Nenhum perfil salvo', enabled: false }];
    }
    return profiles.map<MenuItemConstructorOptions>((profile) => ({
      label: profile.name,
      type: 'radio',
      checked: profile.id === activeProfileId,
      click: () => {
        void applyProfile(profile);
      },
    }));
  }

  function build(): void {
    const settings = getSettings();

    const menu = Menu.buildFromTemplate([
      {
        label: 'Abrir Lumen',
        click: () => {
          showWindow();
        },
      },
      { type: 'separator' },
      { label: 'Perfis', enabled: false },
      ...buildProfileItems(),
      { type: 'separator' },
      {
        label: 'Desligar todas as luzes',
        click: () => {
          void turnEverythingOff();
        },
      },
      {
        label: 'Iniciar com o Windows',
        type: 'checkbox',
        checked: settings.launchOnLogin,
        click: (item) => {
          const launchOnLogin = item.checked;
          setSettings({ launchOnLogin });
          app.setLoginItemSettings({
            openAtLogin: launchOnLogin,
            // Inicia direto na bandeja quando o Windows faz o login.
            args: ['--hidden'],
          });
          onSettingsChanged?.();
          build();
        },
      },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          setQuitting(true);
          app.quit();
        },
      },
    ]);

    tray.setContextMenu(menu);
  }

  // Clique simples na bandeja abre a janela (comportamento esperado no Windows).
  tray.on('click', () => {
    showWindow();
  });

  build();

  return {
    refresh: build,
    setActiveProfile: (id) => {
      activeProfileId = id;
      build();
    },
    destroy: () => {
      tray.destroy();
    },
  };
}

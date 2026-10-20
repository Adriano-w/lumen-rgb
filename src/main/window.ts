/**
 * Janela principal do Lumen.
 *
 * Regra central: fechar a janela NAO encerra o app — esconde para a bandeja.
 * O encerramento real acontece apenas pelo menu da bandeja, que liga a flag
 * `isQuitting` antes de chamar `app.quit()`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, shell } from 'electron';
import { createScopedLogger } from './logger.js';

const log = createScopedLogger('window');

/** Fundo escuro aplicado antes do primeiro paint, para nao piscar branco. */
const BACKGROUND_COLOR = '#0b0b0f';

const resolveFromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/** `out/preload/index.mjs` — ESM, por isso a extensao `.mjs`. */
const PRELOAD_PATH = resolveFromHere('../preload/index.mjs');

/** `out/renderer/index.html` — usado somente em producao. */
const RENDERER_HTML = resolveFromHere('../renderer/index.html');

/** `resources/icon.png` dentro do pacote ou do repositorio em dev. */
function resolveIconPath(): string | undefined {
  const candidates = app.isPackaged
    ? [resolveFromHere('../../resources/icon.png'), resolveFromHere('../../../resources/icon.png')]
    : [resolveFromHere('../../resources/icon.png')];
  return candidates.find((candidate) => existsSync(candidate));
}

let mainWindow: BrowserWindow | null = null;
let quitting = false;

/** Marca que o app esta realmente encerrando (chamado antes de `app.quit()`). */
export function setQuitting(value: boolean): void {
  quitting = value;
}

export function isQuitting(): boolean {
  return quitting;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

export interface CreateWindowOptions {
  /** Quando true, a janela e criada mas nunca mostrada — boot direto na bandeja. */
  startHidden?: boolean;
}

export function createWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const existing = getMainWindow();
  if (existing) return existing;

  const icon = resolveIconPath();

  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: BACKGROUND_COLOR,
    titleBarStyle: 'default',
    autoHideMenuBar: true,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webviewTag: false,
    },
  });

  mainWindow = window;

  window.on('ready-to-show', () => {
    if (options.startHidden) {
      log.info('Janela pronta, mas o app iniciou minimizado na bandeja.');
      return;
    }
    window.show();
  });

  // Links externos abrem no navegador do sistema, nunca dentro do app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Fechar = esconder. Sair de verdade so pela bandeja.
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('O processo do renderer morreu.', details);
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devServerUrl) {
    log.info(`Carregando o renderer do servidor de desenvolvimento: ${devServerUrl}`);
    void window.loadURL(devServerUrl);
  } else {
    log.info(`Carregando o renderer do arquivo: ${RENDERER_HTML}`);
    void window.loadFile(RENDERER_HTML);
  }

  return window;
}

/** Garante que a janela exista, esteja visivel e com foco. */
export function showWindow(): BrowserWindow {
  const window = getMainWindow() ?? createWindow();
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.focus();
  return window;
}

/** Envia um evento para todas as janelas vivas (main -> renderer). */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

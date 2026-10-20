/**
 * Camada fina sobre o electron-log.
 *
 * Centraliza a configuracao dos transportes (arquivo + console) para que o
 * resto do processo principal apenas importe `logger` e escreva.
 */
import log from 'electron-log/main';
import { app } from 'electron';

let initialized = false;

/**
 * Configura os transportes. Pode ser chamada mais de uma vez com seguranca —
 * so a primeira chamada tem efeito.
 */
export function initLogger(): void {
  if (initialized) return;
  initialized = true;

  // Permite que o renderer use `electron-log/renderer` sem configuracao extra.
  log.initialize();

  const isDev = !app.isPackaged;

  log.transports.console.level = isDev ? 'debug' : 'info';
  log.transports.console.format = '[{h}:{i}:{s}.{ms}] [{level}] {scope} {text}';

  log.transports.file.level = isDev ? 'debug' : 'info';
  log.transports.file.fileName = 'lumen.log';
  // ~2 MB por arquivo; o electron-log rotaciona para `lumen.old.log`.
  log.transports.file.maxSize = 2 * 1024 * 1024;
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {scope} {text}';

  // Erros nao tratados tambem vao para o arquivo.
  log.errorHandler.startCatching({ showDialog: false });

  log.info('--- Lumen iniciado ---', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
  });
}

/** Caminho do arquivo de log atual — util para o menu "abrir logs". */
export function getLogFilePath(): string {
  return log.transports.file.getFile().path;
}

/** Conjunto de funcoes de log de um escopo (`info`, `warn`, `error`, ...). */
export type ScopedLogger = ReturnType<typeof log.scope>;

/** Cria um logger com prefixo, para separar as origens das mensagens. */
export function createScopedLogger(scope: string): ScopedLogger {
  return log.scope(scope);
}

export const logger = log;
export default log;

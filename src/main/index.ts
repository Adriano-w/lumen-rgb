/**
 * Bootstrap do processo principal do Lumen.
 *
 * Ordem: log -> instancia unica -> motor -> IPC -> bandeja -> janela.
 * O app sobrevive a uma falha do motor: a UI abre e o status explica o erro.
 */
import { app } from 'electron';
import type {
  Assignment,
  Device,
  Diagnostics,
  EngineStatus,
  Profile,
  TargetRef,
} from '../shared/types.js';
import type { Engine, EngineEvents } from './engine/engine.js';
import { createEngine } from './engine/index.js';
import { applyAutostart, currentMode, refreshTaskTargetIfNeeded } from './autostart.js';
import { isElevated } from './elevation.js';
import { registerIpc } from './ipc.js';
import { createScopedLogger, initLogger } from './logger.js';
import { getProfile, getSettings } from './store.js';
import { createTray, type TrayController } from './tray.js';
import { createWindow, isQuitting, setQuitting, showWindow } from './window.js';

initLogger();
const log = createScopedLogger('main');

/* ------------------------------------------------------------------ *
 * Motor de reserva                                                   *
 * ------------------------------------------------------------------ */

/**
 * Motor inerte usado quando `createEngine()` falha.
 * Mantem o contrato de IPC vivo para a UI poder mostrar o erro em vez de
 * abrir uma janela em branco.
 */
function createDeadEngine(reason: string): Engine {
  const status: EngineStatus = {
    state: 'error',
    reason,
    hint: 'Reinicie o Lumen. Se persistir, verifique os logs em %APPDATA%/lumen/logs.',
  };
  const fail = (): Promise<never> => Promise.reject(new Error(reason));

  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    getStatus: () => status,
    getDiagnostics: (): Promise<Diagnostics> =>
      Promise.resolve({
        pawnIoInstalled: false,
        backendElevated: false,
        smbusAvailable: false,
        conflictingProcesses: [],
        failedInterfaces: [],
      }),
    listDevices: (): Device[] => [],
    rescan: (): Promise<Device[]> => Promise.resolve([]),
    apply: (_target: TargetRef, _assignment: Assignment) => fail(),
    applyAll: (_assignment: Assignment) => fail(),
    applyMany: (_deviceIds: readonly string[], _assignment: Assignment) => fail(),
    resizeZone: (_deviceId: string, _zoneIndex: number, _ledsCount: number) => fail(),
    applyProfile: (_profile: Profile) => fail(),
    on: <K extends keyof EngineEvents>(_event: K, _listener: EngineEvents[K]) => () => {},
  };
}

/* ------------------------------------------------------------------ *
 * Estado do processo                                                 *
 * ------------------------------------------------------------------ */

let engine: Engine | null = null;
let tray: TrayController | null = null;
let disposeIpc: (() => void) | null = null;

/** `--hidden` (atalho de inicializacao do Windows) ou preferencia salva. */
function shouldStartHidden(): boolean {
  const hasFlag = process.argv.includes('--hidden') || process.argv.includes('--start-minimized');
  return hasFlag || getSettings().startMinimized;
}

/**
 * Sincroniza a inicializacao automatica com a preferencia salva.
 *
 * So age quando o estado real diverge do pedido. Reaplicar a cada boot pediria
 * UAC sem motivo, ja que criar a tarefa agendada exige elevacao.
 */
async function syncLoginItem(): Promise<void> {
  const { launchOnLogin } = getSettings();

  try {
    const mode = await currentMode();

    if (launchOnLogin && mode === 'elevated') {
      // Ja esta como queremos. So confere se o caminho do executavel ainda
      // bate — depois de uma atualizacao ele pode ter mudado, e uma tarefa
      // apontando para um binario que nao existe falha calada no logon.
      await refreshTaskTargetIfNeeded();
      return;
    }
    if (!launchOnLogin && mode === 'disabled') return;

    const state = await applyAutostart(launchOnLogin);
    log.info(`Inicializacao automatica: ${state.mode}`);
    if (state.detail) log.warn(state.detail);
  } catch (error) {
    log.warn('Nao foi possivel atualizar a inicializacao automatica.', error);
  }
}

/** Aplica o perfil de boot, se houver. Falha aqui nunca impede o app de subir. */
async function applyBootProfile(activeEngine: Engine): Promise<void> {
  const { bootProfileId } = getSettings();
  if (!bootProfileId) return;

  const profile = getProfile(bootProfileId);
  if (!profile) {
    log.warn(`Perfil de boot "${bootProfileId}" nao foi encontrado.`);
    return;
  }

  try {
    await activeEngine.applyProfile(profile);
    tray?.setActiveProfile(profile.id);
    log.info(`Perfil de boot aplicado: ${profile.name}`);
  } catch (error) {
    log.error(`Falha ao aplicar o perfil de boot "${profile.name}".`, error);
  }
}

/* ------------------------------------------------------------------ *
 * Instancia unica                                                    *
 * ------------------------------------------------------------------ */

/**
 * Instancia unica, mas com uma excecao: **privilegio ganha de antiguidade**.
 *
 * Instancia unica pura tem um efeito perverso aqui. O Lumen abre sem elevacao
 * de proposito, e so enxerga placa-mae e memoria quando elevado. Se o usuario
 * tem o app aberto sem privilegio e reabre como administrador — exatamente o
 * que a propria interface sugere fazer — a instancia nova encontra o bloqueio,
 * traz a janela velha para frente e encerra. A janela volta ao foco, nada
 * muda, e o usuario conclui, com razao, que "abrir como admin nao funciona".
 *
 * A instancia elevada consegue estritamente mais que a comum. Entao ela nao
 * cede: avisa a antiga para sair e assume o lugar.
 */
/** Tentativas de reassumir o bloqueio depois de pedir a saida da outra. */
const TAKEOVER_ATTEMPTS = 20;
const TAKEOVER_INTERVAL_MS = 250;

function startApp(): void {
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    const data = additionalData as { takeover?: boolean } | undefined;

    // Chegou uma instancia elevada e esta aqui nao e: ela faz mais do que nos.
    // Saimos para liberar o barramento e o bloqueio.
    if (data?.takeover === true && !isElevated()) {
      log.info('Instancia elevada chegou; cedendo o lugar e encerrando esta.');
      setQuitting(true);
      void shutdown().finally(() => app.exit(0));
      return;
    }

    log.info('Segunda instancia detectada; trazendo a janela para frente.');
    showWindow();
  });

  // Identificador usado pelo Windows para agrupar notificacoes e a barra de tarefas.
  app.setAppUserModelId('eu.lumen.app');

  void bootstrap();
}

/** Espera a outra instancia sair e tenta reassumir o bloqueio. */
function waitForLock(attempt = 0): void {
  if (app.requestSingleInstanceLock({ takeover: true })) {
    log.info(`Bloqueio assumido na tentativa ${attempt + 1}; seguindo elevado.`);
    startApp();
    return;
  }

  if (attempt + 1 >= TAKEOVER_ATTEMPTS) {
    log.error(
      'A instancia anterior nao encerrou a tempo. Feche o Lumen pela bandeja e abra de novo como administrador.',
    );
    app.exit(1);
    return;
  }

  setTimeout(() => waitForLock(attempt + 1), TAKEOVER_INTERVAL_MS);
}

if (app.requestSingleInstanceLock({ takeover: isElevated() })) {
  startApp();
} else if (isElevated()) {
  // O pedido acima ja entregou `takeover: true` a instancia em execucao, que
  // vai encerrar. Resta esperar o bloqueio ficar livre.
  log.info('Ha uma instancia sem privilegio em execucao; assumindo o lugar dela.');
  waitForLock();
} else {
  log.info('Outra instancia do Lumen ja esta em execucao; encerrando esta.');
  app.quit();
}

/* ------------------------------------------------------------------ *
 * Bootstrap                                                          *
 * ------------------------------------------------------------------ */

async function bootstrap(): Promise<void> {
  await app.whenReady();

  void syncLoginItem();

  // 1. Motor. Se a fabrica explodir, seguimos com o motor inerte.
  let activeEngine: Engine;
  try {
    const settings = getSettings();
    log.info(
      isElevated()
        ? 'Rodando com privilegio: placa-mae e memoria acessiveis.'
        : 'Rodando sem privilegio: apenas perifericos USB e GPU. A UI oferece reiniciar como administrador.',
    );
    activeEngine = await createEngine({
      effectFps: settings.effectFps,
      stopConflictingSoftware: settings.stopConflictingSoftware,
      disableConflictingAutostart: settings.stopConflictingSoftware,
      log: {
        info: (msg) => log.info(msg),
        warn: (msg) => log.warn(msg),
        error: (msg) => log.error(msg),
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error('createEngine() falhou; subindo em modo degradado.', error);
    activeEngine = createDeadEngine(`O motor nao pudo ser inicializado: ${reason}`);
  }
  engine = activeEngine;

  // 2. IPC e bandeja antes da janela — o renderer ja encontra tudo pronto.
  disposeIpc = registerIpc({
    engine: activeEngine,
    onSettingsChanged: () => {
      void syncLoginItem();
      tray?.refresh();
    },
    onProfilesChanged: () => {
      tray?.refresh();
    },
  });

  try {
    tray = createTray({
      engine: activeEngine,
      onSettingsChanged: () => {
        void syncLoginItem();
      },
    });
  } catch (error) {
    log.error('Nao foi possivel criar o icone de bandeja.', error);
  }

  // 3. Janela. Com `--hidden` ela e criada mas nunca mostrada.
  const startHidden = shouldStartHidden();
  log.info(startHidden ? 'Iniciando minimizado na bandeja.' : 'Iniciando com a janela visivel.');
  createWindow({ startHidden });

  app.on('activate', () => {
    showWindow();
  });

  // 4. Conexao com o hardware. Nunca derruba o processo.
  try {
    await activeEngine.start();
    log.info('Motor iniciado.', activeEngine.getStatus());
  } catch (error) {
    log.error('engine.start() rejeitou; o status refletira a falha.', error);
  }

  await applyBootProfile(activeEngine);
}

/* ------------------------------------------------------------------ *
 * Encerramento                                                       *
 * ------------------------------------------------------------------ */

// App de bandeja: fechar a ultima janela nao encerra o processo.
app.on('window-all-closed', () => {
  if (!isQuitting()) return;
  app.quit();
});

let shuttingDown = false;

app.on('before-quit', (event) => {
  setQuitting(true);
  if (shuttingDown) return;
  shuttingDown = true;

  // Dar ao motor a chance de apagar os efeitos e fechar o backend.
  event.preventDefault();
  void shutdown();
});

async function shutdown(): Promise<void> {
  try {
    disposeIpc?.();
  } catch (error) {
    log.warn('Falha ao desregistrar o IPC.', error);
  }

  try {
    await engine?.stop();
  } catch (error) {
    log.error('Falha ao parar o motor.', error);
  }

  try {
    tray?.destroy();
  } catch {
    // Irrelevante durante o encerramento.
  }

  log.info('--- Lumen encerrado ---');
  app.exit(0);
}

process.on('uncaughtException', (error) => {
  log.error('Excecao nao tratada no processo principal.', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Promise rejeitada sem tratamento no processo principal.', reason);
});

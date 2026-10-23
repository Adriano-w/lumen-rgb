/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Inicializacao automatica COM privilegio.
 *
 * O caminho comum — a chave `Run` do Windows, que e o que
 * `app.setLoginItemSettings` usa — inicia o app sem elevacao. Para o Lumen
 * isso significa abrir sem placa-mae e sem memoria toda vez, e depender de o
 * usuario reabrir como administrador manualmente.
 *
 * Marcar o executavel como "sempre executar como administrador" tambem nao
 * resolve: o Windows exibiria o prompt do UAC a cada logon, o que e pior que
 * o problema.
 *
 * A solucao e uma **tarefa agendada com privilegio maximo**. O agendador do
 * Windows e um servico que ja roda elevado, entao ele inicia o processo com
 * privilegio sem prompt nenhum. E exatamente o mecanismo que o utilitario da
 * ASRock usa — foi onde encontramos a tarefa `AsrPolychromeRGB`.
 *
 * Criar a tarefa exige elevacao UMA vez. Depois disso, todo logon e silencioso.
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';
import os from 'node:os';

/** Nome da tarefa no agendador. Estavel: e a chave de criacao e remocao. */
const TASK_NAME = 'Lumen';

export type AutostartMode =
  /** Tarefa agendada com privilegio: o que o Lumen quer. */
  | 'elevated'
  /** Chave Run comum, sem privilegio. Reserva quando a tarefa nao pode ser criada. */
  | 'standard'
  | 'disabled';

export interface AutostartState {
  mode: AutostartMode;
  /** Mensagem para a UI quando o resultado nao foi o pedido. */
  detail?: string;
}

/* ------------------------------------------------------------------ *
 * Execucao de comandos                                               *
 * ------------------------------------------------------------------ */

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Monta uma linha de comando no estilo do Windows.
 *
 * Um argumento com espaco vai entre aspas, e aspas internas sao escapadas com
 * barra invertida — que e o que o `/TR` do `schtasks` exige, ja que o valor
 * dele e, ele proprio, um comando com caminho entre aspas.
 */
function commandLine(args: readonly string[]): string {
  return args
    .map((arg) => {
      const escaped = arg.replace(/"/g, '\\"');
      return /[\s"]/.test(arg) ? `"${escaped}"` : escaped;
    })
    .join(' ');
}

/**
 * Roda `schtasks` elevado, o que mostra o prompt do UAC uma vez.
 *
 * A linha de comando vai como UMA string, montada aqui. Passar um array para
 * o `-ArgumentList` do PowerShell parece mais limpo e nao funciona: ele
 * remonta a linha com as proprias regras de citacao e destroi as aspas
 * aninhadas dentro do `/TR`. O sintoma era um `schtasks` que falhava com
 * E_FAIL generico, enquanto o mesmo comando digitado a mao funcionava.
 */
function runElevated(args: readonly string[]): Promise<boolean> {
  const line = commandLine(args);
  // Aspas simples dobradas: regra de escape de string literal do PowerShell.
  const psLiteral = line.replace(/'/g, "''");
  const command =
    `$p = Start-Process -FilePath 'schtasks.exe' -ArgumentList '${psLiteral}' ` +
    `-Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;

  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true },
    );
    ps.on('error', () => resolve(false));
    ps.on('close', (code) => resolve(code === 0));
  });
}

/* ------------------------------------------------------------------ *
 * Consulta                                                           *
 * ------------------------------------------------------------------ */

/** A tarefa agendada existe? */
export async function hasElevatedTask(): Promise<boolean> {
  const result = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME]);
  return result.code === 0;
}

/** O que esta configurado agora, de fato. */
export async function currentMode(): Promise<AutostartMode> {
  if (await hasElevatedTask()) return 'elevated';
  return app.getLoginItemSettings().openAtLogin ? 'standard' : 'disabled';
}

/* ------------------------------------------------------------------ *
 * Configuracao                                                       *
 * ------------------------------------------------------------------ */

/** Caminho do executavel que a tarefa deve iniciar. */
function targetCommand(): string {
  // Empacotado: o proprio .exe. Em desenvolvimento, o Electron mais o caminho
  // do projeto — util para testar o mecanismo sem gerar instalador.
  const exe = process.execPath;
  const args = app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'];
  return [exe, ...args].map((part) => `"${part}"`).join(' ');
}

/**
 * Cria a tarefa de logon com privilegio maximo.
 *
 * `/RL HIGHEST` e o que faz o processo nascer elevado sem prompt. `/RU` fixa o
 * usuario atual — sem isso a tarefa poderia ser criada para outra conta.
 */
async function createElevatedTask(): Promise<boolean> {
  const user = `${os.hostname()}\\${os.userInfo().username}`;

  return runElevated([
    '/Create',
    '/TN',
    TASK_NAME,
    '/TR',
    targetCommand(),
    '/SC',
    'ONLOGON',
    '/RU',
    user,
    '/RL',
    'HIGHEST',
    // Sobrescreve uma tarefa anterior, que e o caso ao atualizar o app para
    // um caminho novo.
    '/F',
  ]);
}

async function removeElevatedTask(): Promise<boolean> {
  if (!(await hasElevatedTask())) return true;
  return runElevated(['/Delete', '/TN', TASK_NAME, '/F']);
}

function setStandardAutostart(enabled: boolean): void {
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] });
}

/**
 * Aplica a preferencia de inicializacao automatica.
 *
 * Tenta sempre a tarefa elevada primeiro. Se o usuario recusar o UAC, cai
 * para a inicializacao comum e DIZ isso — iniciar sem privilegio e melhor do
 * que nao iniciar, mas o usuario precisa saber que a placa-mae e a memoria
 * nao vao aparecer sozinhas.
 */
export async function applyAutostart(enabled: boolean): Promise<AutostartState> {
  if (!enabled) {
    await removeElevatedTask();
    setStandardAutostart(false);
    return { mode: 'disabled' };
  }

  if (await createElevatedTask()) {
    // As duas coisas juntas iniciariam o app duas vezes.
    setStandardAutostart(false);
    return { mode: 'elevated' };
  }

  setStandardAutostart(true);
  return {
    mode: 'standard',
    detail:
      'O Lumen vai iniciar com o Windows, mas sem privilegio: placa-mae e memoria ' +
      'so aparecem depois de reabrir como administrador. Para iniciar ja elevado, ' +
      'aceite o pedido de permissao ao ligar esta opcao.',
  };
}

/**
 * Mantem a tarefa apontando para o executavel certo.
 *
 * Depois de uma atualizacao o caminho pode mudar, e uma tarefa apontando para
 * um executavel que nao existe mais falha silenciosamente no logon — o tipo de
 * defeito que so aparece semanas depois.
 */
export async function refreshTaskTargetIfNeeded(): Promise<void> {
  if (!(await hasElevatedTask())) return;

  const query = await run('schtasks.exe', ['/Query', '/TN', TASK_NAME, '/FO', 'LIST', '/V']);
  if (query.code !== 0) return;

  // O `schtasks` localiza os rotulos, entao procuramos pelo caminho do
  // executavel no texto em vez de depender do nome do campo.
  if (query.stdout.includes(process.execPath)) return;

  await createElevatedTask();
}

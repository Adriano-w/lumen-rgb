/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Elevacao no Windows.
 *
 * O Lumen roda sem privilegio por padrao e controla o que der: perifericos USB
 * e a iluminacao da GPU nao precisam de nada especial. Placa-mae e memoria
 * precisam, porque passam pelo SMBus, que so existe no kernel.
 *
 * A escolha deliberada e **nao** exigir elevacao para abrir o app. Pedir UAC
 * toda vez para quem so quer mexer no mouse seria hostil. Em vez disso o app
 * abre, mostra o que consegue, e oferece reiniciar com privilegio quando houver
 * hardware que depende disso.
 */
import { app } from 'electron';
import { spawn } from 'node:child_process';

// `isElevated` mora em `privilege.ts`, sem dependencia do Electron, porque o
// worker de hardware tambem precisa da resposta e nao tem `app`.
export { isElevated } from './privilege.js';

/**
 * Reabre o Lumen com privilegio e encerra esta instancia.
 *
 * O processo elevado e outro processo: o lock de instancia unica desta
 * instancia precisa sair do caminho antes, senao o novo se mata achando que ja
 * existe um Lumen aberto. Por isso encerramos so depois de disparar, e o novo
 * processo espera o antigo sumir.
 */
export function relaunchElevated(onFailure: (reason: string) => void): void {
  const exe = process.execPath;
  const args = app.isPackaged
    ? []
    : // Em desenvolvimento o executavel e o Electron, e o caminho do app
      // precisa ir junto, senao o processo elevado abre a janela padrao dele.
      [app.getAppPath()];

  const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const argList = args.length > 0 ? ` -ArgumentList ${args.map(psQuote).join(',')}` : '';
  const command = `Start-Process -FilePath ${psQuote(exe)}${argList} -Verb RunAs`;

  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { windowsHide: true, detached: true, stdio: 'ignore' },
  );

  ps.on('error', (err) => {
    onFailure(`nao consegui reiniciar com privilegio: ${err.message}`);
  });

  ps.on('exit', (code) => {
    if (code === 0) {
      // Da um instante para o processo novo aparecer antes de liberar o lock.
      setTimeout(() => app.exit(0), 600);
    } else {
      onFailure('O pedido de elevacao foi recusado.');
    }
  });

  ps.unref();
}

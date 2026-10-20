/*
 * Lumen — GPL-2.0-or-later. Veja LICENSE.
 */

/**
 * Deteccao e resolucao de conflito com software de OEM.
 *
 * O SMBus admite um escritor por vez. Com o utilitario do fabricante rodando
 * junto, as duas aplicacoes intercalam escritas nos registros do controller e o
 * resultado nao e "a ultima vence" — e lixo: a placa pisca em cores aleatorias.
 *
 * Por isso isto roda ANTES de qualquer acesso ao barramento.
 */
import { spawn } from 'node:child_process';

const CONFLICTING_PROCESSES: ReadonlyArray<{ image: string; label: string }> = [
  { image: 'AsrPolychromeRGB.exe', label: 'ASRock Polychrome RGB' },
  { image: 'PolychromeLauncher.exe', label: 'ASRock Polychrome Launcher' },
  { image: 'iCUE.exe', label: 'Corsair iCUE' },
  { image: 'LightingService.exe', label: 'ASUS Aura / Armoury Crate' },
  { image: 'ArmouryCrate.Service.exe', label: 'ASUS Armoury Crate' },
  { image: 'MysticLight.exe', label: 'MSI Mystic Light' },
  { image: 'RGBFusion.exe', label: 'Gigabyte RGB Fusion' },
  { image: 'SignalRgb.exe', label: 'SignalRGB' },
  { image: 'OpenRGB.exe', label: 'OpenRGB' },
];

/** Tarefas agendadas que trazem esses programas de volta no boot. */
const AUTOSTART_TASKS: Record<string, string> = {
  'ASRock Polychrome RGB': 'AsrPolychromeRGB',
  'ASRock Polychrome Launcher': 'AsrPolychromeRGB',
};

/** Lista os softwares de OEM rodando que disputam o barramento. */
export function detectConflictingProcesses(): Promise<string[]> {
  return new Promise((resolve) => {
    // `tasklist` em CSV e mais barato e mais estavel que subir um PowerShell.
    const child = spawn('tasklist.exe', ['/fo', 'csv', '/nh'], { windowsHide: true });
    let out = '';
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const running = new Set<string>();
      const lower = out.toLowerCase();
      for (const { image, label } of CONFLICTING_PROCESSES) {
        if (lower.includes(`"${image.toLowerCase()}"`)) running.add(label);
      }
      resolve([...running]);
    });
  });
}

/**
 * Encerra um software de OEM concorrente.
 *
 * Varios rodam elevados — o Polychrome, por exemplo, sobe por tarefa agendada
 * com privilegio — e um `taskkill` sem elevacao falha com acesso negado. Entao
 * tentamos sem elevacao primeiro, para nao incomodar com UAC a toa, e so
 * escalamos quando preciso.
 */
export async function stopProcessByLabel(label: string): Promise<boolean> {
  const entry = CONFLICTING_PROCESSES.find((p) => p.label === label);
  if (!entry) return false;

  if (await taskkill(entry.image, false)) return true;
  return taskkill(entry.image, true);
}

function taskkill(image: string, elevated: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const child = elevated
      ? spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Start-Process -FilePath 'taskkill.exe' -ArgumentList '/im','${image}','/f' -Verb RunAs -WindowStyle Hidden -Wait`,
          ],
          { windowsHide: true },
        )
      : spawn('taskkill.exe', ['/im', image, '/f'], { windowsHide: true });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Impede que o software de OEM volte no proximo boot.
 *
 * Desativar e deliberadamente preferivel a desinstalar: resolve a disputa pelo
 * barramento e o usuario reverte com um clique se quiser o app original de
 * volta.
 */
export function disableAutostart(label: string): Promise<boolean> {
  const task = AUTOSTART_TASKS[label];
  if (!task) return Promise.resolve(false);

  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath 'schtasks.exe' -ArgumentList '/Change','/TN','${task}','/DISABLE' -Verb RunAs -WindowStyle Hidden -Wait`,
      ],
      { windowsHide: true },
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

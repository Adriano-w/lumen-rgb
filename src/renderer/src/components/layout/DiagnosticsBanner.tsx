import { useState } from 'react';
import { ChevronDown, ExternalLink, ShieldAlert, TriangleAlert, Unplug, X } from 'lucide-react';

import type { Diagnostics } from '@shared/types';
import { Badge, Button } from '@renderer/components/ui';
import { cn } from '@renderer/lib/utils';

interface Issue {
  id: string;
  severity: 'critical' | 'attention';
  title: string;
  /** O que esta acontecendo, em linguagem de gente. */
  explanation: string;
  /** O que o usuario deve fazer. */
  action: string;
  /** Link que o usuario precisa abrir para cumprir a acao, quando houver. */
  link?: { href: string; label: string };
}

/**
 * Traduz o diagnostico em problemas acionaveis.
 *
 * Na maquina alvo, placa-mae e RAM dependem do driver PawnIO instalado
 * E do backend rodando elevado — os dois primeiros casos abaixo.
 */
function collectIssues(diagnostics: Diagnostics): Issue[] {
  const issues: Issue[] = [];

  // UM problema de cada vez, na ordem em que precisam ser resolvidos.
  //
  // Antes, driver ausente e falta de privilegio apareciam juntos — e pior,
  // "sem privilegio" era deduzido de "o SMBus nao abriu", entao num PC sem o
  // driver o app pedia para reiniciar como administrador. O usuario fazia
  // isso, nada mudava, e a mesma mensagem continuava la. Pedir duas coisas
  // quando so a primeira importa transforma um passo claro em adivinhacao.
  if (!diagnostics.pawnIoInstalled) {
    issues.push({
      id: 'pawnio',
      severity: 'critical',
      title: 'Falta o driver PawnIO',
      explanation:
        'A placa-mae e a memoria conversam por SMBus, e no Windows esse acesso so existe atraves de um driver. O PawnIO e assinado, roda em sandbox e e compativel com a Integridade de Memoria — por isso o Lumen usa ele em vez de carregar um driver de acesso irrestrito.',
      action:
        'Baixe e instale o PawnIO em pawnio.eu, depois reabra o Lumen. Mouse, teclado, headset e placa de video continuam funcionando normalmente sem ele.',
      link: { href: 'https://pawnio.eu', label: 'Abrir pawnio.eu' },
    });
  } else if (!diagnostics.backendElevated) {
    // So faz sentido pedir privilegio depois que o driver existe.
    issues.push({
      id: 'elevation',
      severity: 'critical',
      title: 'O Lumen esta sem permissao de administrador',
      explanation:
        'O driver PawnIO esta instalado, mas so aceita comandos de um processo elevado. Sem isso, a placa-mae e a memoria ficam fora de alcance.',
      action:
        'Feche o Lumen pela bandeja e abra de novo com o botao direito, "Executar como administrador". Para nao repetir todo dia, ligue "Iniciar com o Windows" nas configuracoes — ele passa a subir ja elevado, sem pedir permissao de novo.',
    });
  } else if (!diagnostics.smbusAvailable) {
    // Driver instalado, processo elevado, e mesmo assim nada. E outra coisa.
    issues.push({
      id: 'smbus',
      severity: 'critical',
      title: 'O barramento SMBus nao abriu',
      explanation:
        'O driver esta instalado e o Lumen tem permissao de administrador, entao o problema nao e nenhum dos dois. Pode ser um chipset ainda sem suporte, ou o servico do PawnIO parado.',
      action:
        'Reinicie o computador. Se continuar, confira se o servico PawnIO esta em execucao nos Servicos do Windows.',
    });
  }

  if (diagnostics.conflictingProcesses.length > 0) {
    issues.push({
      id: 'conflicts',
      severity: 'attention',
      title: 'Outro programa de RGB esta aberto',
      explanation: `O SMBus aceita um controlador por vez. Encontramos ${diagnostics.conflictingProcesses.join(', ')} em execucao, disputando o acesso com o Lumen — o resultado costuma ser cor piscando ou comando ignorado.`,
      action:
        'Feche esse programa (e tire ele da inicializacao do Windows). Voce tambem pode deixar o Lumen encerrar ele sozinho ao iniciar, nas configuracoes.',
    });
  }

  if (diagnostics.failedInterfaces.length > 0) {
    const n = diagnostics.failedInterfaces.length;
    issues.push({
      id: 'interfaces',
      severity: 'attention',
      title: n === 1 ? 'Um driver falhou' : `${n} drivers falharam`,
      explanation: `Durante a varredura, ${diagnostics.failedInterfaces.join('; ')}. Devices dessas familias podem ter ficado de fora da lista; o resto foi detectado normalmente.`,
      action:
        'Tente "Procurar devices" de novo. Se continuar, reiniciar o computador resolve na maioria dos casos.',
    });
  }

  return issues;
}

const SEVERITY = {
  critical: {
    icon: ShieldAlert,
    wrapper: 'border-destructive/30 bg-destructive/8',
    iconTone: 'text-destructive',
    badge: 'danger' as const,
    badgeLabel: 'Precisa de acao',
  },
  attention: {
    icon: TriangleAlert,
    wrapper: 'border-warning/35 bg-warning-soft',
    iconTone: 'text-warning',
    badge: 'warning' as const,
    badgeLabel: 'Atencao',
  },
};

export interface DiagnosticsBannerProps {
  diagnostics: Diagnostics | null;
  /** Mostra tambem o aviso de backend fora do ar. */
  disconnectedReason?: string;
  onRescan?: () => void;
}

export function DiagnosticsBanner({
  diagnostics,
  disconnectedReason,
  onRescan,
}: DiagnosticsBannerProps) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const issues = diagnostics ? collectIssues(diagnostics) : [];
  const visible = issues.filter((issue) => !dismissed.includes(issue.id));

  if (!disconnectedReason && visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-3 px-8 pt-6">
      {disconnectedReason ? (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/8 px-4 py-3.5">
          <Unplug className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-foreground">
              O Lumen perdeu contato com o servico de iluminacao
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {disconnectedReason} Nada foi perdido — assim que o servico voltar, suas cores sao
              reaplicadas.
            </p>
          </div>
          {onRescan ? (
            <Button variant="outline" size="sm" className="ml-auto shrink-0" onClick={onRescan}>
              Tentar de novo
            </Button>
          ) : null}
        </div>
      ) : null}

      {visible.map((issue) => {
        const tone = SEVERITY[issue.severity];
        const Icon = tone.icon;
        const isOpen = expanded === issue.id;

        return (
          <div
            key={issue.id}
            className={cn('rounded-lg border px-4 py-3.5 transition-colors', tone.wrapper)}
          >
            <div className="flex items-start gap-3">
              <Icon className={cn('mt-0.5 size-4 shrink-0', tone.iconTone)} aria-hidden />

              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-foreground">{issue.title}</p>
                  <Badge variant={tone.badge}>{tone.badgeLabel}</Badge>
                </div>
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {issue.explanation}
                </p>

                {isOpen ? (
                  <div className="mt-2 rounded-md bg-surface-1/70 px-3 py-2.5">
                    <p className="text-sm leading-relaxed text-foreground">
                      <span className="font-medium">O que fazer: </span>
                      {issue.action}
                    </p>

                    {/*
                      Quando a acao depende de baixar algo, o link vai junto.
                      Mandar o usuario procurar um site que a mensagem so cita
                      e transformar um passo em duas tarefas.
                      O `setWindowOpenHandler` do processo principal abre no
                      navegador do sistema, nunca dentro do app.
                    */}
                    {issue.link ? (
                      <a
                        href={issue.link.href}
                        target="_blank"
                        rel="noreferrer"
                        className={cn(
                          'mt-2.5 inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5',
                          'text-sm font-medium text-primary-foreground bg-primary',
                          'transition-colors hover:bg-primary/90',
                          'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                        )}
                      >
                        {issue.link.label}
                        <ExternalLink className="size-3.5" aria-hidden />
                      </a>
                    ) : null}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : issue.id)}
                  aria-expanded={isOpen}
                  className={cn(
                    'mt-1 inline-flex w-fit items-center gap-1 rounded-sm text-xs font-medium text-primary',
                    'outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                  )}
                >
                  {isOpen ? 'Esconder' : 'Como resolver'}
                  <ChevronDown
                    className={cn('size-3 transition-transform', isOpen && 'rotate-180')}
                    aria-hidden
                  />
                </button>
              </div>

              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Dispensar aviso: ${issue.title}`}
                onClick={() => setDismissed((list) => [...list, issue.id])}
              >
                <X />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

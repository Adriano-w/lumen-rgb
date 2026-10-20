# Lumen

Controle unificado de iluminação RGB para Windows. Autossuficiente: fala com o
hardware por conta própria, sem servidor nem aplicativo de terceiros no caminho.

## Por que existe

O ASRock Polychrome controla a placa-mãe e pouco mais. Nesta máquina ele vê
**1 device**; o Lumen vê **5**:

| Device | Transporte | LEDs |
|---|---|---|
| ASRock B450M Steel Legend | SMBus PIIX4 porta 1, `0x6A` | 23 + até 80 no header ARGB |
| Kingston Fury DDR4 | SMBus PIIX4 porta 0, `0x58`/`0x59` | 20 |
| Gigabyte RTX 3060 EAGLE OC | NVAPI I2C, `0x63` | 1 |
| Logitech G733 | HID | 2 |
| Logitech G502 LIGHTSPEED | HID | 2 |

Com a fita ARGB configurada no máximo, são **128 LEDs** endereçáveis.

E o Polychrome **não tem sistema de perfis** — guarda um único blob de estado
dentro de `Program Files`. O Lumen tem perfis nomeados e aplica um no login.

O diferencial real, porém, são os **efeitos em software**: 13 efeitos calculados
pelo app e empurrados por LED, em fase, para todos os devices ao mesmo tempo.
Um arco-íris atravessa placa-mãe, memória, GPU e periféricos como uma coisa só —
nenhum firmware de fabricante faz isso, porque cada um só enxerga o próprio
hardware.

## Arquitetura

```
┌──────────────────────────────────────────────────┐
│ Lumen (Electron)                                 │
│                                                  │
│  renderer (React) ──IPC──▶ main                  │
│                             │                    │
│                   ┌─────────▼─────────┐          │
│                   │ motor             │          │
│                   │ · efeitos         │          │
│                   │ · perfis          │          │
│                   │ · diagnóstico     │          │
│                   └─────────┬─────────┘          │
│                   ┌─────────▼─────────┐          │
│                   │ detector          │          │
│                   └─────────┬─────────┘          │
│          ┌──────────────────┼──────────────────┐ │
│    ┌─────▼─────┐      ┌─────▼─────┐      ┌─────▼─│──┐
│    │ SMBus     │      │ NVAPI     │      │ HID   │  │
│    │ (PawnIO)  │      │ (nvapi64) │      │(node-hid)│
│    └─────┬─────┘      └─────┬─────┘      └─────┬─│──┘
└──────────┼──────────────────┼──────────────────┼─┘
       placa-mãe            GPU              periféricos
        memória
```

Os drivers de protocolo vivem em `src/main/engine/controllers/`. Adicionar
suporte a uma família nova é um arquivo ali e uma linha no detector.

### A única dependência externa: PawnIO

Não existe acesso a SMBus no Windows em modo usuário — alguém precisa estar no
kernel. As alternativas seriam carregar um driver de port-IO irrestrito
(WinRing0, ou o `MsIo64.sys` que a ASRock instala — ambos permitem escrita
arbitrária em memória física, e o primeiro está na blocklist de drivers
vulneráveis da Microsoft) ou assinar um driver próprio, o que exige certificado
EV mais atestação da Microsoft.

[PawnIO](https://pawnio.eu) é a opção correta: assinado, compatível com Memory
Integrity/HVCI, e executa bytecode verificado em sandbox em vez de expor I/O
cru. É um **driver**, não um aplicativo — nada dele disputa o barramento.

Os módulos `.bin` em `resources/pawnio/` vêm do
[PawnIO.Modules](https://github.com/namazso/PawnIO.Modules) upstream, assinados.

## Privilégio

O Lumen abre **sem elevação** e controla o que der: periféricos USB e GPU não
precisam de nada especial. Placa-mãe e memória precisam, porque passam pelo
SMBus. Pedir UAC toda vez para quem só quer mexer no mouse seria hostil — então
o app abre, mostra o que consegue, e oferece reiniciar com privilégio quando
houver hardware que dependa disso.

## Requisitos

- Windows 10/11 x64
- Node.js ≥ 22 (desenvolvido em 24.14.1)
- [PawnIO](https://pawnio.eu) — só para placa-mãe e memória

## Como rodar

```bash
npm install
npm run dev          # desenvolvimento
npm run typecheck    # checagem de tipos
npm run build        # build de produção
npm run dist         # instalador NSIS em release/
```

### Validação contra hardware real

Escrevem no hardware de verdade. Rode **como administrador** para alcançar
placa-mãe e memória.

```bash
npm run probe:buses      # só os transportes: PawnIO, varredura SMBus, HID, GPU
npm run probe            # enumera devices, valida o modelo, testa escrita
npm run probe:smbus      # só os drivers SMBus, sem passar pelo detector geral
npm run probe:effects    # valida os 13 kernels e roda um efeito nos devices
npm run restore          # devolve tudo a um modo de firmware autônomo
npm run restore -- Static
npm run probe:argb       # mostra a configuração do header ARGB
npm run probe:argb -- walk     # descobre o tamanho real da fita, de olho
npm run probe:argb -- 56 7     # configura 56 LEDs em 7 grupos (fans)
npm run probe:stability  # roda a detecção 5× e compara — pega intermitência
npm run probe:sync       # prova que os efeitos ficam em fase entre devices
npm run demo:sync        # firmware x Lumen lado a lado, para ver a diferença
```

`probe:buses` responde "o Lumen consegue falar com o barramento?" antes de
qualquer pergunta sobre device específico — é assim que se separa problema de
transporte de problema de driver.

`probe:stability` existe porque "funcionou uma vez" não prova nada num
barramento compartilhado: a memória já apareceu com dois módulos numa execução
e um na seguinte. Rode-o depois de mexer em qualquer driver SMBus.

### O header ARGB

O registrador `0x32` guarda **quantos LEDs a fita tem**, e esse valor vive no
hardware — sobrevive a reinicializações e ao app fechado. O registrador `0x33`
reporta a *capacidade* do header (80 nesta placa), não o que está ligado nele;
não há como perguntar ao hardware quantos LEDs existem de fato, só olhando.

O OpenRGB enxerga esse header como **um LED só**. Não é limitação do firmware:
ele escreve um bloco vazio em `0x32` antes de cada cor, o que no barramento é o
byte `0`, e isso zera a contagem. Com a contagem correta gravada, o firmware
aceita endereçar cada LED (`0x31` = `0x19 + índice`).

> **Passar nestes scripts não prova que o app funciona.** Eles rodam em Node
> puro; o Electron tem o sandbox do V8 ligado e proíbe coisas que o Node
> permite (veja a armadilha nº 7). Teste sempre no app também.

## Sincronia entre devices — leia isto

Há dois jeitos de acender as luzes, e eles se comportam de forma diferente:

**Modos de firmware** (Rainbow, Wave, Neon…) rodam dentro do controlador de
cada device. Funcionam com o Lumen fechado, não custam nada e sobrevivem a
reinicializações. Mas **não podem ser sincronizados entre devices**: a placa-mãe
anima no chip Nuvoton dela, a memória no controlador dela, a GPU no dela —
relógios independentes, velocidades diferentes, iniciados em momentos
diferentes. Nenhum software alinha isso. Nem o Lumen, nem o Polychrome, nem o
OpenRGB. É limitação física, não defeito.

**Efeitos do Lumen** são calculados pelo app a partir de uma **origem de tempo
única** e empurrados por LED. Esses sim ficam em fase — verificado medindo: dois
alvos registrados com 1,5s de diferença renderizam a cor idêntica, diferença
**zero** (`npm run probe:sync`). O preço é que exigem o app aberto.

A aba **"Todos os devices"** existe para isso: escolher um efeito e aplicá-lo a
tudo de uma vez, em sincronia real.

> Houve um bug real aqui: cada alvo guardava a própria origem de tempo, definida
> quando entrou. Como aplicar a cinco devices são cinco chamadas sequenciais e
> uma escrita SMBus leva centenas de milissegundos, o último device começava
> quase um segundo depois do primeiro. Corrigido com uma origem compartilhada.

`npm run demo:sync` mostra os dois lados: 20s em modo de firmware, 25s com
efeito do Lumen. A diferença é visível.

## Efeitos

13 efeitos implementados e validados em hardware: `static`, `breathing`,
`strobe`, `color-cycle`, `rainbow-wave`, `gradient`, `wave`, `comet`, `scan`,
`chase`, `twinkle`, `fire`, `alternating`.

Os kernels são **funções puras** — `(ledIndex, ledCount, t, params) → RGB`. Sem
estado interno, por dois motivos: qualquer frame pode ser reavaliado, e dois
devices no mesmo efeito ficam automaticamente em fase. Efeitos que parecem
aleatórios (`twinkle`, `fire`) usam ruído derivado por hash das coordenadas, que
é determinístico mas não parece.

`audio-level` e `ambient-screen` estão declarados mas **não implementados** —
precisam de captura de áudio e de tela. `isEffectAvailable()` reporta isso e a
UI os mostra desabilitados.

## Licença

**GPL-2.0-or-later** (veja `LICENSE`).

Parte dos drivers de protocolo deriva do [OpenRGB](https://openrgb.org), também
GPL-2.0-or-later; cada arquivo portado nomeia sua origem no cabeçalho. É por
isso que o Lumen é GPL: foi uma escolha deliberada, para poder aproveitar o
acervo de conhecimento de protocolo que a comunidade já construiu em vez de
redescobrir cada registrador por engenharia reversa.

## Armadilhas que custaram caro

Documentadas porque não são óbvias:

1. **SMBus admite um escritor só.** Com o software do OEM rodando junto, as
   escritas se intercalam e o resultado não é "a última vence" — é lixo: a placa
   pisca em cores aleatórias. O Lumen detecta os concorrentes e oferece
   encerrá-los, inclusive desativando a tarefa agendada que os traz de volta.
2. **Segure o mutex `Global\Access_SMBUS.HTP.Method`.** É o nome que a indústria
   inteira usa para arbitrar o SMBus no Windows. No mesmo barramento mora o SPD
   das memórias — lixo ali é sério.
3. **Varredura de barramento só com leitura.** Uma varredura que escreve pode
   reprogramar um SPD e deixar a máquina sem bootar.
4. **Modo direto congela o device na saída.** Enquanto o device está em
   "Direct"/"Static", quem pinta é o host; se o app fecha, ele trava na última
   cor recebida. O Lumen devolve ao firmware um modo autônomo ao sair.
5. **A placa ASRock não tem modo "Direct".** Ela aceita escrita por LED no modo
   `Static`. O detector procura `Direct`, depois `Custom`, depois qualquer modo
   que declare cor-por-LED.
6. **SMBus é lento.** Memória e GPU rodam a 8 fps, HID a 30, e a placa-mãe a 2
   (desgaste de flash). O teto é deliberado — saturar o barramento trava a
   detecção. Cada driver **declara** seu transporte (`Controller.transport`);
   inferir isso do texto de `location` já causou bug — um driver reescreveu a
   própria mensagem e a placa passou a ser atualizada a 20 fps.
7. **No Electron, FFI não pode usar memória externa.** O sandbox do V8 proíbe
   criar um `ArrayBuffer` sobre memória que não é dele, e `koffi.view()` faz
   exatamente isso. O resultado não é exceção: é crash fatal, sem log. Pior,
   **o mesmo código funciona em Node puro**, então os scripts de validação
   passam. Use `Buffer` e `koffi.encode`, nunca `koffi.alloc` + `koffi.view`.
8. **Uma transação SMBus que falha não significa endereço vazio.** O barramento
   é compartilhado e instável; `probe()` tenta 3 vezes, e o mesmo vale para
   qualquer handshake de detecção — o *unlock* da Kingston também precisou de
   retry, e sem ele a memória aparecia ora com dois módulos, ora com um.
9. **Bloco SMBus de comprimento zero não existe.** Alguns firmwares o usam como
   "toque" num registrador; o driver rejeita. No barramento é idêntico a um
   `byte_data` com valor 0, e é assim que o HAL traduz.
10. **Efeitos precisam de uma origem de tempo compartilhada.** Dar a cada alvo
    a própria origem defasa tudo, porque registrá-los é sequencial e lento.
11. **Os dois pentes de memória se alinham pelo `NUM_SLOTS`, não pelo índice.**
    O registrador `0x27` diz ao firmware quantos módulos existem, e é isso que
    os coordena. Escrever a posição física em `0x0B` parece a coisa certa — é a
    tentação óbvia para encadear o efeito entre os pentes — mas **trava o
    segundo módulo numa cor fixa**. Ambos em índice 0, com `NUM_SLOTS` correto.
12. **`0x11` não é um modo na GPU Gigabyte.** Os valores são bits (`0x01`
    estático, `0x02` respiração, `0x04` piscando, `0x08` piscando duplo, `0x10`
    ciclo). O `0x11` é `0x10 | 0x01`, e o firmware responde **piscando**. Era
    exposto como "Spectrum Cycle" e virava o padrão do `restore`, porque o nome
    batia com o das outras placas. Removido; o ciclo real é `Color Cycle`
    (`0x10`).
13. **O firmware da memória não aceita duas transações abertas ao mesmo tempo.**
    Tentar abrir `BEGIN` nos dois pentes antes de escrever — o mais próximo de
    "simultâneo" que o barramento permitiria — falha com `0x800701B1`.

## Limites conhecidos

- Cobertura de hardware é o que está em `controllers/`. Hoje: ASRock Polychrome,
  Kingston Fury, NVIDIA GPU, Logitech HID++. Crescer é adicionar arquivos ali.
- Só chipsets AMD (PIIX4) por enquanto. Intel usa `SmbusI801.bin`, com a mesma
  interface de módulo — o módulo já está em `resources/pawnio/`.
- O header ARGB é endereçável por LED, mas **não verificado visualmente** nesta
  máquina: a hub de fans tem controle próprio e, sem pilha nele, pode estar no
  modo interno em vez de "MB sync" — nesse estado ela ignora o sinal da placa, e
  nenhum software corrige isso. Os registradores respondem e a contagem persiste;
  falta confirmar que as fans obedecem.
- As escritas de hardware são síncronas no processo principal. A 8 fps isso é
  tolerável; se a UI engasgar, o próximo passo é mover a HAL para um worker.

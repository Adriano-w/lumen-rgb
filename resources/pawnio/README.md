# Módulos PawnIO

Bytecode verificado que dá ao Lumen acesso ao barramento SMBus — é por aqui que
a placa-mãe e a memória são alcançadas.

## Origem

Estes `.bin` **não são nossos**. Vêm sem modificação do projeto upstream:

- **Projeto:** [namazso/PawnIO.Modules](https://github.com/namazso/PawnIO.Modules)
- **Versão:** 0.2.11 (release de 30/08/2026)
- **Licença:** LGPL-2.1 (veja `COPYING.LGPL-2.1` nesta pasta)

Verificação de integridade — `SmbusPIIX4.bin`, SHA-256:

```
91F9B4B1C39E3D399CE48477A89D8F6BD3E58A2241064A4DAEC3A1513DFF56E5
```

Esse hash é idêntico ao do binário que o OpenRGB distribui, o que confirma que
ambos os projetos consomem o mesmo artefato upstream em vez de recompilá-lo.

## O que cada um faz

| Arquivo | Para que serve |
|---|---|
| `SmbusPIIX4.bin` | SMBus em chipsets **AMD** — é o usado nesta máquina |
| `SmbusI801.bin` | SMBus em chipsets **Intel** |
| `SmbusNCT6793.bin` | SMBus via Super-I/O Nuvoton |
| `SmbusIntelSkylakeIMC.bin` | Controlador de memória integrado Intel Skylake |

Hoje o Lumen só carrega o `SmbusPIIX4.bin`. Os outros acompanham porque dar
suporte a Intel é trocar qual módulo é carregado — a interface é a mesma — e
descobrir isso depois custaria mais do que os 100 KB que eles ocupam.

## Por que binário e não código

Compilar módulos PawnIO exige o toolchain do projeto deles. Mais importante:
estes artefatos vêm **assinados** pelo upstream, e é a assinatura que permite
carregá-los com Memory Integrity ativo. Recompilar quebraria exatamente a
propriedade que os torna utilizáveis.

O driver em si (`PawnIOLib.dll` + `PawnIO.sys`) **não** é redistribuído aqui —
o usuário instala de [pawnio.eu](https://pawnio.eu). O Lumen apenas detecta e
explica quando ele falta.

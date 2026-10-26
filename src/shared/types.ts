/**
 * Modelo de dominio do Lumen, compartilhado entre main, preload e renderer.
 * Nada aqui pode importar modulos de Node ou do Electron.
 */

/* ------------------------------------------------------------------ *
 * Cor                                                                *
 * ------------------------------------------------------------------ */

export interface RGB {
  r: number; // 0-255
  g: number;
  b: number;
}

/* ------------------------------------------------------------------ *
 * Taxonomia de hardware                                              *
 * ------------------------------------------------------------------ */

/** Ordem identica ao enum device_type do OpenRGB — o indice e o valor do fio. */
export const DEVICE_TYPES = [
  'motherboard',
  'dram',
  'gpu',
  'cooler',
  'ledstrip',
  'keyboard',
  'mouse',
  'mousemat',
  'headset',
  'headset-stand',
  'gamepad',
  'light',
  'speaker',
  'virtual',
  'storage',
  'case',
  'microphone',
  'accessory',
  'keypad',
  'unknown',
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

/** Ordem identica ao enum zone_type do OpenRGB. */
export const ZONE_TYPES = ['single', 'linear', 'matrix'] as const;
export type ZoneType = (typeof ZONE_TYPES)[number];

/** De qual backend o device veio. Permite misturar drivers de origens diferentes. */
export type BackendId = 'openrgb' | 'hid';

/**
 * Como os bytes chegam ao device.
 *
 * Determina o teto de taxa de atualizacao: SMBus e I2C de GPU sao lentos e
 * compartilhados, HID e rapido e dedicado. Cada driver declara o seu — inferir
 * a partir de um texto de localizacao ja causou bug aqui.
 */
export type TransportKind = 'smbus' | 'gpu-i2c' | 'hid' | 'usb' | 'serial' | 'unknown';

/* ------------------------------------------------------------------ *
 * Flags de modo (espelham MODE_FLAG_* do OpenRGB)                    *
 * ------------------------------------------------------------------ */

export const MODE_FLAG = {
  HAS_SPEED: 1 << 0,
  HAS_DIRECTION_LR: 1 << 1,
  HAS_DIRECTION_UD: 1 << 2,
  HAS_DIRECTION_HV: 1 << 3,
  HAS_BRIGHTNESS: 1 << 4,
  HAS_PER_LED_COLOR: 1 << 5,
  HAS_MODE_SPECIFIC_COLOR: 1 << 6,
  HAS_RANDOM_COLOR: 1 << 7,
  MANUAL_SAVE: 1 << 8,
  AUTOMATIC_SAVE: 1 << 9,
  HAS_DIRECTION_DIAG: 1 << 10,
} as const;

/** Como o modo consome cores. Espelha MODE_COLORS_* do OpenRGB. */
export const COLOR_MODE = {
  NONE: 0,
  PER_LED: 1,
  MODE_SPECIFIC: 2,
  RANDOM: 3,
} as const;

export type ColorModeValue = (typeof COLOR_MODE)[keyof typeof COLOR_MODE];

export const DIRECTION = {
  LEFT: 0,
  RIGHT: 1,
  UP: 2,
  DOWN: 3,
  HORIZONTAL: 4,
  VERTICAL: 5,
} as const;

/* ------------------------------------------------------------------ *
 * Hardware normalizado                                               *
 * ------------------------------------------------------------------ */

export interface DeviceMode {
  index: number;
  name: string;
  flags: number;
  colorMode: ColorModeValue;
  /** `undefined` quando o modo nao suporta velocidade. */
  speed?: { min: number; max: number; current: number };
  /** `undefined` quando o modo nao suporta brilho. */
  brightness?: { min: number; max: number; current: number };
  direction?: number;
  colors: RGB[];
  colorsMin: number;
  colorsMax: number;
  /** True quando o modo aceita uma cor por LED — e o que o motor de efeitos exige. */
  supportsPerLed: boolean;
}

export interface DeviceSegment {
  name: string;
  type: ZoneType;
  startIdx: number;
  ledsCount: number;
}

export interface DeviceZone {
  index: number;
  name: string;
  type: ZoneType;
  ledsCount: number;
  ledsMin: number;
  ledsMax: number;
  /** Primeiro indice global de LED desta zona dentro do device. */
  ledOffset: number;
  matrix?: { width: number; height: number; map: number[] };
  segments: DeviceSegment[];
  /** Zona com tamanho configuravel (header ARGB sem contagem conhecida). */
  resizable: boolean;
}

export interface DeviceLed {
  index: number;
  name: string;
}

export interface Device {
  /** Chave estavel do Lumen: `<backend>:<identidade>`. Nunca o indice. */
  id: string;
  backend: BackendId;
  /** Indice no backend. Volatil — revalidado a cada redeteccao. */
  backendIndex: number;
  name: string;
  displayName: string;
  vendor: string;
  description: string;
  type: DeviceType;
  version: string;
  serial: string;
  location: string;
  /** Por onde os bytes passam. Define o teto de taxa de atualizacao. */
  transport: TransportKind;
  ledCount: number;
  leds: DeviceLed[];
  zones: DeviceZone[];
  modes: DeviceMode[];
  activeModeIndex: number;
  colors: RGB[];
  /** True se o device tem um modo "Direct" — requisito para efeitos do Lumen. */
  supportsDirect: boolean;
  /** Indice do modo direto, quando existir. */
  directModeIndex?: number;
  /**
   * O firmware deste device grava na flash a cada escrita de cor.
   *
   * Efeitos do Lumen reescrevem continuamente, entao consomem ciclos de uma
   * flash finita. Os modos do proprio firmware nao tem esse custo — rodam
   * dentro do controlador. A UI deve avisar antes de deixar o usuario rodar
   * um efeito longo num device assim.
   */
  writeWearRisk: boolean;
}

/* ------------------------------------------------------------------ *
 * Efeitos do Lumen (nosso motor, nao os do firmware)                 *
 * ------------------------------------------------------------------ */

export type EffectKind =
  | 'static'
  | 'breathing'
  | 'strobe'
  | 'color-cycle'
  | 'rainbow-wave'
  | 'gradient'
  | 'wave'
  | 'comet'
  | 'scan'
  | 'chase'
  | 'twinkle'
  | 'fire'
  | 'alternating'
  | 'audio-level'
  | 'ambient-screen';

/**
 * Metadados de cada efeito: o que ele faz e QUAIS controles fazem sentido.
 *
 * A UI usa isso para mostrar so os controles aplicaveis — um efeito sem
 * velocidade nao deve exibir um slider de velocidade inerte.
 */
export interface EffectDescriptor {
  kind: EffectKind;
  label: string;
  description: string;
  usesSpeed: boolean;
  usesDirection: boolean;
  /** Comprimento de onda em LEDs. So faz sentido em efeitos espaciais. */
  usesSpread: boolean;
  /** 0 = o efeito gera as proprias cores e ignora a paleta. */
  minColors: number;
  maxColors: number;
  /**
   * Precisa de varios LEDs para fazer sentido.
   *
   * Um efeito espacial distribui algo ao longo da fita; num alvo de 1 LED ele
   * nao tem o que mostrar. A interface usa isto para nao oferecer, por
   * exemplo, "Varredura" quando so a GPU (1 LED) esta selecionada.
   *
   * E um julgamento, nao uma propriedade mecanica: `fire` tambem usa a posicao
   * do LED, mas num LED so ainda parece fogo, entao nao e espacial para este
   * fim. Por isso mora aqui, junto do resto dos metadados de interface, e nao
   * numa lista a parte que pode divergir em silencio.
   */
  spatial: boolean;
  /**
   * Precisa capturar audio ou tela. Efeitos assim ainda nao tem kernel neste
   * build — `isEffectAvailable()` no motor e a fonte da verdade.
   */
  requiresCapture: boolean;
}

export const EFFECT_DESCRIPTORS: readonly EffectDescriptor[] = [
  {
    kind: 'static',
    label: 'Cor fixa',
    description: 'Uma cor so, sem movimento.',
    usesSpeed: false, usesDirection: false, usesSpread: false,
    minColors: 1, maxColors: 1, spatial: false, requiresCapture: false,
  },
  {
    kind: 'breathing',
    label: 'Respiracao',
    description: 'A cor acende e apaga suavemente, com pausa no escuro.',
    usesSpeed: true, usesDirection: false, usesSpread: false,
    minColors: 1, maxColors: 4, spatial: false, requiresCapture: false,
  },
  {
    kind: 'strobe',
    label: 'Strobe',
    description: 'Flash seco, liga e desliga sem transicao.',
    usesSpeed: true, usesDirection: false, usesSpread: false,
    minColors: 1, maxColors: 4, spatial: false, requiresCapture: false,
  },
  {
    kind: 'color-cycle',
    label: 'Ciclo de cores',
    description: 'O device inteiro percorre o espectro, ou a sua paleta.',
    usesSpeed: true, usesDirection: true, usesSpread: false,
    minColors: 0, maxColors: 8, spatial: false, requiresCapture: false,
  },
  {
    kind: 'rainbow-wave',
    label: 'Onda arco-iris',
    description: 'Arco-iris que corre ao longo dos LEDs.',
    usesSpeed: true, usesDirection: true, usesSpread: true,
    minColors: 0, maxColors: 0, spatial: true, requiresCapture: false,
  },
  {
    kind: 'gradient',
    label: 'Degrade',
    description: 'A paleta esticada ao longo do device, deslizando.',
    usesSpeed: true, usesDirection: true, usesSpread: false,
    minColors: 2, maxColors: 8, spatial: true, requiresCapture: false,
  },
  {
    kind: 'wave',
    label: 'Onda',
    description: 'Um pulso da sua cor viajando pelos LEDs.',
    usesSpeed: true, usesDirection: true, usesSpread: true,
    minColors: 1, maxColors: 2, spatial: true, requiresCapture: false,
  },
  {
    kind: 'comet',
    label: 'Cometa',
    description: 'Um ponto brilhante com rastro que se apaga atras.',
    usesSpeed: true, usesDirection: true, usesSpread: true,
    minColors: 1, maxColors: 2, spatial: true, requiresCapture: false,
  },
  {
    kind: 'scan',
    label: 'Varredura',
    description: 'Uma barra que vai e volta, estilo Knight Rider.',
    usesSpeed: true, usesDirection: false, usesSpread: true,
    minColors: 1, maxColors: 2, spatial: true, requiresCapture: false,
  },
  {
    kind: 'chase',
    label: 'Marcha',
    description: 'Pontos espacados desfilando em sequencia.',
    usesSpeed: true, usesDirection: true, usesSpread: true,
    minColors: 1, maxColors: 4, spatial: true, requiresCapture: false,
  },
  {
    kind: 'twinkle',
    label: 'Cintilancia',
    description: 'LEDs acendem e apagam em pontos aleatorios.',
    usesSpeed: true, usesDirection: false, usesSpread: false,
    minColors: 1, maxColors: 4, spatial: true, requiresCapture: false,
  },
  {
    kind: 'fire',
    label: 'Chama',
    description: 'Fogo vivo, em tons de vermelho e amarelo.',
    usesSpeed: true, usesDirection: false, usesSpread: false,
    minColors: 0, maxColors: 0, spatial: false, requiresCapture: false,
  },
  {
    kind: 'alternating',
    label: 'Alternado',
    description: 'Duas cores trocando de lugar entre os LEDs.',
    usesSpeed: true, usesDirection: false, usesSpread: true,
    minColors: 2, maxColors: 2, spatial: true, requiresCapture: false,
  },
  {
    kind: 'audio-level',
    label: 'Reagir ao som',
    description: 'A iluminacao acompanha o audio do sistema.',
    usesSpeed: false, usesDirection: false, usesSpread: false,
    minColors: 1, maxColors: 4, spatial: false, requiresCapture: true,
  },
  {
    kind: 'ambient-screen',
    label: 'Ambiente da tela',
    description: 'As cores acompanham o que esta na tela.',
    usesSpeed: false, usesDirection: false, usesSpread: false,
    minColors: 0, maxColors: 0, spatial: false, requiresCapture: true,
  },
];

export function effectDescriptor(kind: EffectKind): EffectDescriptor | undefined {
  return EFFECT_DESCRIPTORS.find((d) => d.kind === kind);
}

export interface EffectParams {
  /** Paleta usada pelo efeito. Efeitos de 1 cor usam a primeira. */
  colors: RGB[];
  /** 0-100, normalizado pelo motor para a faixa do efeito. */
  speed: number;
  /** 0-100, multiplicador global aplicado na saida. */
  brightness: number;
  /** Direcao para efeitos espaciais. */
  direction: 'forward' | 'reverse';
  /** Comprimento de onda em LEDs, para efeitos de onda. */
  spread: number;
}

export interface EffectSpec {
  kind: EffectKind;
  params: EffectParams;
}

/** Como um alvo (device ou zona) e pintado. */
export type Assignment =
  | { mode: 'hardware'; modeIndex: number; colors: RGB[]; speed?: number; brightness?: number; direction?: number }
  | { mode: 'lumen'; effect: EffectSpec };

export interface TargetRef {
  deviceId: string;
  /** `undefined` = device inteiro. */
  zoneIndex?: number;
}

/* ------------------------------------------------------------------ *
 * Perfis                                                             *
 * ------------------------------------------------------------------ */

export interface ProfileEntry {
  target: TargetRef;
  assignment: Assignment;
}

export interface Profile {
  id: string;
  name: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  entries: ProfileEntry[];
}

/* ------------------------------------------------------------------ *
 * Estado do motor                                                    *
 * ------------------------------------------------------------------ */

export type EngineStatus =
  | { state: 'starting' }
  | { state: 'connected'; protocolVersion: number; serverVersion: number }
  | { state: 'disconnected'; reason: string }
  | { state: 'error'; reason: string; hint?: string };

/** Problemas de ambiente que a UI precisa explicar e, quando possivel, resolver. */
export interface Diagnostics {
  /** Driver PawnIO presente — necessario para SMBus (placa-mae, RAM). */
  pawnIoInstalled: boolean;
  /**
   * O processo tem privilegio de administrador.
   *
   * Pergunta separada de `smbusAvailable` de proposito. Juntar as duas ja
   * produziu conselho errado em laco: sem o driver instalado o barramento nao
   * abre, a interface concluia "falta privilegio" e pedia para reiniciar como
   * administrador — o que nao resolvia nada, e a mensagem nunca mudava.
   */
  backendElevated: boolean;
  /**
   * O barramento SMBus abriu. Precisa de PawnIO instalado E privilegio; quando
   * e falso com os dois presentes, o problema e outro (chipset sem suporte,
   * driver parado) e `failedInterfaces` tem o detalhe.
   */
  smbusAvailable: boolean;
  /** Software OEM concorrente detectado, que disputa o SMBus. */
  conflictingProcesses: string[];
  /** Interfaces I2C/SMBus que falharam na ultima deteccao. */
  failedInterfaces: string[];
}

/* ------------------------------------------------------------------ *
 * Contrato de IPC (renderer -> main)                                 *
 * ------------------------------------------------------------------ */

/** O que deu certo e o que nao deu, numa aplicacao em lote. */
export interface ApplyManyResult {
  applied: string[];
  failed: Array<{ deviceId: string; error: string }>;
}

export interface LumenApi {
  getStatus(): Promise<EngineStatus>;
  getDiagnostics(): Promise<Diagnostics>;
  listDevices(): Promise<Device[]>;
  rescan(): Promise<Device[]>;

  /** Aplica uma atribuicao imediatamente, sem salvar em perfil. */
  apply(target: TargetRef, assignment: Assignment): Promise<void>;
  /** Pinta todos os devices com uma unica cor — o botao de panico. */
  applyAll(assignment: Assignment): Promise<void>;
  /**
   * Aplica a um subconjunto de devices, numa unica ida ao backend.
   *
   * Nao e so economia de chamadas. O motor usa a lista para montar uma **fita
   * virtual**: os devices entram em sequencia e um efeito espacial atravessa
   * todos como se fossem uma fita so. Aplicando um por vez, cada device
   * recomeca o efeito do zero — e o resultado nao parece um efeito unico,
   * parece cada device fazendo uma coisa diferente.
   *
   * A ordem importa: e a ordem fisica que o efeito vai percorrer.
   */
  applyMany(deviceIds: readonly string[], assignment: Assignment): Promise<ApplyManyResult>;
  /** Redimensiona uma zona de tamanho configuravel (header ARGB). */
  resizeZone(deviceId: string, zoneIndex: number, ledsCount: number): Promise<void>;

  listProfiles(): Promise<Profile[]>;
  saveProfile(profile: Profile): Promise<Profile>;
  loadProfile(id: string): Promise<void>;
  deleteProfile(id: string): Promise<void>;

  getSettings(): Promise<Settings>;
  setSettings(patch: Partial<Settings>): Promise<Settings>;

  /** Eventos main -> renderer. Devolve a funcao de cancelamento. */
  onDevicesChanged(cb: (devices: Device[]) => void): () => void;
  onStatusChanged(cb: (status: EngineStatus) => void): () => void;
}

export interface Settings {
  launchOnLogin: boolean;
  startMinimized: boolean;
  /** Perfil aplicado no login. */
  bootProfileId: string | null;
  theme: 'system' | 'light' | 'dark';
  /** FPS alvo do motor de efeitos. */
  effectFps: number;
  /** Encerra o software OEM concorrente ao iniciar. */
  stopConflictingSoftware: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  launchOnLogin: false,
  startMinimized: false,
  bootProfileId: null,
  theme: 'system',
  effectFps: 30,
  stopConflictingSoftware: false,
};

export const DEFAULT_EFFECT_PARAMS: EffectParams = {
  colors: [{ r: 255, g: 0, b: 80 }],
  speed: 50,
  brightness: 100,
  direction: 'forward',
  spread: 24,
};

/**
 * Kernels de efeito: funcoes puras que, dado um LED e um instante, devolvem a
 * cor. Sem estado e sem IO — assim o motor pode reavaliar qualquer frame, e
 * dois devices pintados pelo mesmo efeito ficam em fase.
 */
import type { EffectKind, EffectParams, RGB } from '../../../shared/types.js';

export interface KernelContext {
  /** Indice do LED dentro do alvo (0 = primeiro LED da zona ou do device). */
  ledIndex: number;
  /** Total de LEDs do alvo. Util para efeitos que normalizam a posicao. */
  ledCount: number;
  /** Tempo em segundos desde o inicio do efeito. */
  t: number;
  params: EffectParams;
}

export type Kernel = (ctx: KernelContext) => RGB;

const BLACK: RGB = { r: 0, g: 0, b: 0 };

/* ------------------------------------------------------------------ *
 * Utilitarios de cor                                                 *
 * ------------------------------------------------------------------ */

/** h em [0,1), s e v em [0,1]. */
export function hsvToRgb(h: number, s: number, v: number): RGB {
  const hh = ((h % 1) + 1) % 1; // normaliza negativos
  const i = Math.floor(hh * 6);
  const f = hh * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r: number;
  let g: number;
  let b: number;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}

/** Interpola uma paleta em `k` ∈ [0,1], com wrap-around. */
function samplePalette(colors: readonly RGB[], k: number, wrap: boolean): RGB {
  if (colors.length === 0) return BLACK;
  if (colors.length === 1) return colors[0]!;

  const kk = wrap ? ((k % 1) + 1) % 1 : Math.max(0, Math.min(1, k));
  const span = wrap ? colors.length : colors.length - 1;
  const pos = kk * span;
  const i0 = Math.floor(pos) % colors.length;
  const i1 = (i0 + 1) % colors.length;
  const f = pos - Math.floor(pos);

  const a = colors[i0]!;
  const b = colors[i1]!;
  return {
    r: Math.round(lerp(a.r, b.r, f)),
    g: Math.round(lerp(a.g, b.g, f)),
    b: Math.round(lerp(a.b, b.b, f)),
  };
}

function scale(c: RGB, k: number): RGB {
  const kk = Math.max(0, Math.min(1, k));
  return {
    r: Math.round(c.r * kk),
    g: Math.round(c.g * kk),
    b: Math.round(c.b * kk),
  };
}

/** Converte o `speed` 0-100 da UI em ciclos por segundo. */
function cyclesPerSecond(speed: number, slowest: number, fastest: number): number {
  const k = Math.max(0, Math.min(100, speed)) / 100;
  return lerp(slowest, fastest, k);
}

function directionSign(params: EffectParams): number {
  return params.direction === 'reverse' ? -1 : 1;
}

/* ------------------------------------------------------------------ *
 * Kernels                                                            *
 * ------------------------------------------------------------------ */

const staticKernel: Kernel = ({ params }) => params.colors[0] ?? BLACK;

const breathingKernel: Kernel = ({ t, params }) => {
  const hz = cyclesPerSecond(params.speed, 0.08, 0.9);
  // seno elevado deixa a pausa no escuro mais longa, que e o que da a
  // sensacao de respiracao em vez de pulso.
  const phase = Math.sin(2 * Math.PI * hz * t);
  const k = Math.pow((phase + 1) / 2, 1.6);
  // Com mais de uma cor, cada respiracao usa a proxima da paleta — a troca
  // acontece no vale, onde esta apagado, entao nao se ve o corte.
  const palette = params.colors.length > 0 ? params.colors : [BLACK];
  const breath = Math.floor(t * hz + 0.75);
  const color = palette[((breath % palette.length) + palette.length) % palette.length]!;
  return scale(color, 0.04 + 0.96 * k);
};

const rainbowWaveKernel: Kernel = ({ ledIndex, t, params }) => {
  const hz = cyclesPerSecond(params.speed, 0.05, 0.8);
  const spread = Math.max(1, params.spread);
  const hue = ledIndex / spread + directionSign(params) * hz * t;
  return hsvToRgb(hue, 1, 1);
};

const colorCycleKernel: Kernel = ({ t, params }) => {
  const hz = cyclesPerSecond(params.speed, 0.03, 0.5);
  // Com paleta de uma cor so, cicla todo o espectro; com varias, percorre
  // a paleta do usuario.
  if (params.colors.length <= 1) {
    return hsvToRgb(directionSign(params) * hz * t, 1, 1);
  }
  return samplePalette(params.colors, directionSign(params) * hz * t, true);
};

const gradientKernel: Kernel = ({ ledIndex, ledCount, t, params }) => {
  const hz = cyclesPerSecond(params.speed, 0, 0.4);
  const base = ledCount <= 1 ? 0 : ledIndex / (ledCount - 1);
  const drift = directionSign(params) * hz * t;
  return samplePalette(params.colors, base + drift, true);
};

/* ------------------------------------------------------------------ *
 * Ruido deterministico                                               *
 *                                                                    *
 * Efeitos como cintilancia e chama precisam PARECER aleatorios sem SER:
 * um kernel com estado interno nao pode ser reavaliado, e dois devices
 * no mesmo efeito sairiam de fase. A solucao e ruido derivado por hash
 * das coordenadas (posicao, passo de tempo) — mesma entrada, mesma saida.
 * ------------------------------------------------------------------ */

/** Hash inteiro 2D -> [0,1). */
function noise2(a: number, b: number): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Ruido suavizado no tempo: interpola entre dois passos inteiros. */
function smoothNoise(seed: number, tStep: number): number {
  const i = Math.floor(tStep);
  const f = tStep - i;
  // suavizacao cubica para nao deixar o movimento com cara de serrilha
  const k = f * f * (3 - 2 * f);
  return lerp(noise2(seed, i), noise2(seed, i + 1), k);
}

/* ------------------------------------------------------------------ *
 * Kernels espaciais                                                  *
 * ------------------------------------------------------------------ */

const strobeKernel: Kernel = ({ t, params }) => {
  const hz = cyclesPerSecond(params.speed, 0.5, 12);
  const phase = (t * hz) % 1;
  // ciclo de trabalho curto: o flash e mais seco que um quadrado 50/50
  const on = phase < 0.35;
  if (!on) return BLACK;
  // com paleta de varias cores, cada flash pega a proxima
  const idx = Math.floor(t * hz) % Math.max(1, params.colors.length);
  return params.colors[idx] ?? BLACK;
};

/** Posicao da cabeca do efeito, em LEDs, no instante t. */
function headPosition(ctx: KernelContext, slowest: number, fastest: number): number {
  const { t, params, ledCount } = ctx;
  const hz = cyclesPerSecond(params.speed, slowest, fastest);
  const travel = directionSign(params) * hz * t * ledCount;
  return ((travel % ledCount) + ledCount) % ledCount;
}

/** Distancia circular entre dois pontos de uma fita fechada. */
function ringDistance(a: number, b: number, size: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, size - d);
}

const waveKernel: Kernel = (ctx) => {
  const { ledIndex, ledCount, params } = ctx;
  const head = headPosition(ctx, 0.05, 1.2);
  const width = Math.max(1, Math.min(params.spread, ledCount));
  const d = ringDistance(ledIndex, head, ledCount);
  // meia-senoide: pico na cabeca, zero na borda do pulso
  const k = d >= width ? 0 : Math.cos((d / width) * (Math.PI / 2));
  const base = params.colors[0] ?? BLACK;
  const bg = params.colors[1];
  if (!bg) return scale(base, k);
  return {
    r: Math.round(lerp(bg.r, base.r, k)),
    g: Math.round(lerp(bg.g, base.g, k)),
    b: Math.round(lerp(bg.b, base.b, k)),
  };
};

const cometKernel: Kernel = (ctx) => {
  const { ledIndex, ledCount, params } = ctx;
  const head = headPosition(ctx, 0.05, 1.5);
  const tail = Math.max(1, Math.min(params.spread, ledCount));
  // rastro so atras da cabeca: a distancia e dirigida, nao simetrica
  const behind = directionSign(params) > 0 ? head - ledIndex : ledIndex - head;
  const d = ((behind % ledCount) + ledCount) % ledCount;
  const k = d >= tail ? 0 : Math.pow(1 - d / tail, 1.8);
  return scale(params.colors[0] ?? BLACK, k);
};

const scanKernel: Kernel = ({ ledIndex, ledCount, t, params }) => {
  const hz = cyclesPerSecond(params.speed, 0.08, 1.6);
  // triangular: vai e volta em vez de dar a volta
  const phase = (t * hz) % 1;
  const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
  const head = tri * Math.max(0, ledCount - 1);
  const width = Math.max(1, Math.min(params.spread, ledCount));
  const d = Math.abs(ledIndex - head);
  const k = d >= width ? 0 : Math.pow(1 - d / width, 2);
  const base = params.colors[0] ?? BLACK;
  const bg = params.colors[1];
  if (!bg) return scale(base, k);
  return {
    r: Math.round(lerp(bg.r, base.r, k)),
    g: Math.round(lerp(bg.g, base.g, k)),
    b: Math.round(lerp(bg.b, base.b, k)),
  };
};

const chaseKernel: Kernel = (ctx) => {
  const { ledIndex, ledCount, params } = ctx;
  const head = headPosition(ctx, 0.05, 1.5);
  const gap = Math.max(2, Math.min(params.spread, ledCount));
  // posicao relativa a cabeca, modulo o espacamento entre os pontos
  const rel = ((ledIndex - head) % gap + gap) % gap;
  const lit = rel < 1;
  if (!lit) return BLACK;
  const group = Math.floor(((ledIndex - head) + ledCount * 2) / gap);
  const palette = params.colors.length > 0 ? params.colors : [{ r: 255, g: 255, b: 255 }];
  return palette[group % palette.length] ?? BLACK;
};

const twinkleKernel: Kernel = ({ ledIndex, t, params }) => {
  const rate = cyclesPerSecond(params.speed, 0.2, 3);
  // Cada LED tem o seu proprio relogio, deslocado por um offset derivado do
  // indice. Assim eles nao piscam todos juntos.
  const offset = noise2(ledIndex, 7919) * 10;
  const local = (t + offset) * rate;
  const cycle = Math.floor(local);
  const phase = local - cycle;

  // Nem todo ciclo acende: o sorteio decide se este LED participa.
  if (noise2(ledIndex, cycle) > 0.45) return BLACK;

  // acende rapido, apaga devagar
  const k = phase < 0.2 ? phase / 0.2 : Math.pow(1 - (phase - 0.2) / 0.8, 1.5);
  const palette = params.colors.length > 0 ? params.colors : [{ r: 255, g: 255, b: 255 }];
  const color = palette[Math.floor(noise2(ledIndex, cycle + 31) * palette.length) % palette.length];
  return scale(color ?? BLACK, k);
};

const fireKernel: Kernel = ({ ledIndex, t, params }) => {
  const rate = cyclesPerSecond(params.speed, 1.5, 9);
  // Duas camadas de ruido em velocidades diferentes dao o tremular; a lenta
  // sozinha parece respiracao, a rapida sozinha parece estatica.
  const slow = smoothNoise(ledIndex * 13 + 1, t * rate * 0.45);
  const fast = smoothNoise(ledIndex * 29 + 7, t * rate);
  const heat = Math.max(0, Math.min(1, slow * 0.65 + fast * 0.55 - 0.1));

  // Rampa de corpo negro aproximada: vermelho sobe primeiro, depois verde,
  // e o azul so aparece nas pontas mais quentes.
  const r = Math.min(1, heat * 1.9);
  const g = Math.max(0, Math.min(1, (heat - 0.35) * 1.7));
  const b = Math.max(0, Math.min(1, (heat - 0.82) * 3));
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
};

const alternatingKernel: Kernel = ({ ledIndex, t, params }) => {
  const hz = cyclesPerSecond(params.speed, 0.15, 5);
  const block = Math.max(1, params.spread);
  const group = Math.floor(ledIndex / block);
  const flip = Math.floor(t * hz);
  const a = params.colors[0] ?? BLACK;
  const b = params.colors[1] ?? BLACK;
  return (group + flip) % 2 === 0 ? a : b;
};

/* ------------------------------------------------------------------ *
 * Registro                                                           *
 * ------------------------------------------------------------------ */

const KERNELS: Partial<Record<EffectKind, Kernel>> = {
  static: staticKernel,
  breathing: breathingKernel,
  strobe: strobeKernel,
  'color-cycle': colorCycleKernel,
  'rainbow-wave': rainbowWaveKernel,
  gradient: gradientKernel,
  wave: waveKernel,
  comet: cometKernel,
  scan: scanKernel,
  chase: chaseKernel,
  twinkle: twinkleKernel,
  fire: fireKernel,
  alternating: alternatingKernel,
  // 'audio-level' e 'ambient-screen' exigem captura de audio/tela e ainda nao
  // tem kernel. `isEffectAvailable` reporta isso para a UI.
};

/** Efeitos que este build consegue renderizar. */
export const AVAILABLE_EFFECTS: readonly EffectKind[] = Object.keys(KERNELS) as EffectKind[];

export function isEffectAvailable(kind: EffectKind): boolean {
  return KERNELS[kind] !== undefined;
}

export function getKernel(kind: EffectKind): Kernel {
  const k = KERNELS[kind];
  if (!k) {
    throw new Error(`efeito "${kind}" nao esta disponivel neste build do Lumen`);
  }
  return k;
}

/**
 * Renderiza um alvo inteiro, aplicando o brilho global por ultimo.
 * Reusa o array de saida para nao alocar a cada frame.
 */
export function renderTarget(
  kind: EffectKind,
  params: EffectParams,
  ledCount: number,
  t: number,
  out: RGB[],
): RGB[] {
  const kernel = getKernel(kind);
  const gain = Math.max(0, Math.min(100, params.brightness)) / 100;

  for (let i = 0; i < ledCount; i++) {
    const c = kernel({ ledIndex: i, ledCount, t, params });
    const existing = out[i];
    const r = Math.round(c.r * gain);
    const g = Math.round(c.g * gain);
    const b = Math.round(c.b * gain);
    if (existing) {
      existing.r = r;
      existing.g = g;
      existing.b = b;
    } else {
      out[i] = { r, g, b };
    }
  }
  out.length = ledCount;
  return out;
}

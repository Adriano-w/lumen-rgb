import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Junta classes resolvendo conflitos do Tailwind (a ultima vence). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Prende um numero na faixa [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Formata contagem de LEDs em pt-BR: "1 LED" / "24 LEDs". */
export function formatLeds(count: number): string {
  return count === 1 ? '1 LED' : `${count} LEDs`;
}

/** Data ISO -> "20/10/2026 14:32". */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Id curto e estavel o suficiente para perfis criados na UI. */
export function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

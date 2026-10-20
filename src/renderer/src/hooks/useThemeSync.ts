import { useEffect } from 'react';
import type { Settings } from '@shared/types';

/**
 * Espelha `settings.theme` no atributo `data-theme` do <html>.
 *
 * Em "system" o atributo e removido, e o CSS volta a decidir por
 * `prefers-color-scheme`. Tambem ajusta `color-scheme`, para os controles
 * nativos (scrollbar, caret) acompanharem o tema.
 */
export function useThemeSync(theme: Settings['theme']): void {
  useEffect(() => {
    const root = document.documentElement;

    if (theme === 'system') {
      root.removeAttribute('data-theme');
      root.style.colorScheme = 'light dark';
      return;
    }

    root.setAttribute('data-theme', theme);
    root.style.colorScheme = theme;
  }, [theme]);
}

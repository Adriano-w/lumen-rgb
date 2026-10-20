import { fileURLToPath } from 'node:url';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Raiz do projeto, resolvida de forma segura em ESM. */
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const resolvePath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

/**
 * Dependencias nativas ou que precisam do require do Node em runtime.
 * Nunca podem entrar no bundle do processo principal.
 */
const nativeDeps = ['electron-store', 'electron-log', 'node-hid'];

/** Externaliza o pacote e qualquer subcaminho dele (ex.: `electron-log/main`). */
const externalPatterns = [...nativeDeps, ...nativeDeps.map((dep) => new RegExp(`^${dep}/`))];

const sharedAliases = {
  '@shared': resolvePath('./src/shared'),
  '@renderer': resolvePath('./src/renderer/src'),
};

export default defineConfig({
  main: {
    root: projectRoot,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: sharedAliases,
    },
    build: {
      outDir: 'out/main',
      target: 'node22',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        // O campo `main` do package.json aponta para `./out/main/index.mjs`.
        input: { index: resolvePath('./src/main/index.ts') },
        external: externalPatterns,
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name]-[hash].mjs',
        },
      },
    },
  },

  preload: {
    root: projectRoot,
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: sharedAliases,
    },
    build: {
      outDir: 'out/preload',
      target: 'node22',
      minify: false,
      sourcemap: true,
      rollupOptions: {
        input: { index: resolvePath('./src/preload/index.ts') },
        external: externalPatterns,
        output: {
          format: 'es',
          entryFileNames: '[name].mjs',
          chunkFileNames: '[name]-[hash].mjs',
        },
      },
    },
  },

  renderer: {
    root: resolvePath('./src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: sharedAliases,
    },
    build: {
      outDir: resolvePath('./out/renderer'),
      emptyOutDir: true,
      sourcemap: true,
      rollupOptions: {
        input: { index: resolvePath('./src/renderer/index.html') },
      },
    },
  },
});

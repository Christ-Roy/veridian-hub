import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./__tests__/setup.ts'],
    // Le bastion porte la coordination de la flotte : 2 workers par défaut (22/11, 5 workers le saturaient à 97 %).
    // Une machine dédiée (runner CI, `lourd` sur rise) peut monter : VITEST_MAX_WORKERS=<n>.
    maxWorkers: Number(process.env.VITEST_MAX_WORKERS) || 2,
    include: ['__tests__/**/*.test.{ts,tsx}'],
    coverage: {
      reporter: ['text', 'json-summary'],
      include: ['utils/**', 'config/**', 'app/api/**'],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@veridian/shared': path.resolve(__dirname, './shared/shared/index.ts'),
    },
  },
});

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react(), tsconfigPaths({
    projects: ['./test-tsconfig.json']
  })],
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: './test/setup.ts',
    include: ['**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/playwright/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['test/**/*', '**/*.d.ts', '**/*.config.*'],
    },
    alias: {
      '@': resolve(__dirname, './src'),
    },
    typecheck: {
      tsconfig: './test-tsconfig.json',
      include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    }
  },
});

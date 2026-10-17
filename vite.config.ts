import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const rootDir = import.meta.dirname;

export default defineConfig({
  root: resolve(rootDir, 'src/sidepanel'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: false,
    target: 'chrome114',
    sourcemap: false,
    rollupOptions: {
      input: resolve(rootDir, 'src/sidepanel/index.html'),
    },
  },
});

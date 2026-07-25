import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The bundled UI for the local Mobile Inspector service (`src/service/server.ts` serves this output
// as static assets). Output goes to `ui-dist/` — deliberately outside `dist/` so `tsc -b --clean`
// (which only removes tsc's own build outputs) never wipes the UI bundle, and vice versa.
export default defineConfig({
  root: 'ui',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../ui-dist',
    emptyOutDir: true,
  },
});

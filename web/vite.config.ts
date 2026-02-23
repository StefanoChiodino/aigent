import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:3141', ws: true },
      '/tts': 'http://localhost:3141',
      '/stt': 'http://localhost:3141',
      '/settings': 'http://localhost:3141',
      '/files': 'http://localhost:3141',
    },
  },
});

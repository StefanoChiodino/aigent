import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo';

  return {
    root: 'web',
    // For GitHub Pages sub-path: set VITE_BASE_PATH=/aigent/ (or whatever the repo name is)
    base: isDemo ? (process.env.VITE_BASE_PATH ?? '/') : '/',
    plugins: [react()],
    build: {
      outDir: isDemo ? 'dist-demo' : 'dist',
      emptyOutDir: true,
      sourcemap: !isDemo,
      minify: isDemo ? 'esbuild' : false,
    },
    server: {
      port: 5173,
      clearScreen: false,
      proxy: isDemo ? undefined : {
        // /ws is NOT proxied — the frontend connects directly to the backend
        // WebSocket to avoid ECONNREFUSED noise during tsx-watch restarts.
        '/tts': 'http://localhost:3141',
        '/stt': 'http://localhost:3141',
        '/settings': 'http://localhost:3141',
        '/files': 'http://localhost:3141',
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/__tests__/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      coverage: {
        provider: 'v8',
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/__tests__/**', 'src/demo/**'],
        reporter: ['text', 'text-summary'],
      },
    },
  };
});

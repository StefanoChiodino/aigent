import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const isDemo = mode === 'demo';

  return {
    root: 'web',
    plugins: [react()],
    build: {
      outDir: isDemo ? 'dist-demo' : 'dist',
      emptyOutDir: true,
      sourcemap: !isDemo,
    },
    server: {
      port: 5173,
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
    },
  };
});

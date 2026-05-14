import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In production, the Express server serves the built frontend from /web/dist.
// The proxy is only needed for local development.
const isDev = process.env.NODE_ENV !== 'production';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: isDev
      ? {
          '/api': { target: 'http://localhost:9090', changeOrigin: true },
          '/auth': { target: 'http://localhost:9090', changeOrigin: true },
          '/admin': { target: 'http://localhost:9090', changeOrigin: true },
          '/s/': { target: 'http://localhost:9090', changeOrigin: true },
          '/health': { target: 'http://localhost:9090', changeOrigin: true },
        }
      : undefined,
  },
});

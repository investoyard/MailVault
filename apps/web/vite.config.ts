import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Keep the browser's Host header so the API's cross-site (Origin) check sees the same host.
    proxy: { '/api': { target: 'http://127.0.0.1:3200', changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1500,
  },
});

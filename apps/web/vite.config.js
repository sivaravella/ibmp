import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/v1': 'http://localhost:4000' } },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 400,
    rollupOptions: { output: { manualChunks: { react: ['react', 'react-dom'] } } },   // the framework changes rarely: cache it separately
  },
});

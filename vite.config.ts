import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
  build: {
    sourcemap: false,
    // Vite inlines small assets as data: URIs, but the content security policy
    // only allows fonts from this origin (font-src 'self'). Fonts always ship as
    // files.
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
  },
  worker: { format: 'es' },
});

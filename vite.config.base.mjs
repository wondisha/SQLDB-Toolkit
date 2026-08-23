import { defineConfig } from 'vite';

export default defineConfig({
  root: 'frontend',
  publicDir: false,
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'frontend/index.html'
    }
  }
});

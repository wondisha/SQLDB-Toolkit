import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.base.mjs';

export default mergeConfig(
  baseConfig,
  defineConfig({
    server: {
      host: '0.0.0.0',
      port: 5173
    },
    preview: {
      host: '0.0.0.0',
      port: 4173
    },
    build: {
      minify: false,
      sourcemap: true
    }
  })
);

import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.base.mjs';

export default mergeConfig(
  baseConfig,
  defineConfig({
    build: {
      minify: 'esbuild',
      sourcemap: true,
      cssCodeSplit: false
    }
  })
);

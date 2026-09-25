import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { index: 'src/index.ts', 'background-extension': 'src/pi-rpc/background-extension.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  dts: false,
  splitting: false,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node'
  }
})

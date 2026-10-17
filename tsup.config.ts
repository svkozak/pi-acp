import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/acp/pi-mcp-bridge.ts'],
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

import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
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
  },
  {
    // The MCP bridge pi loads with `-e`. Bundled into one self-contained file
    // (all deps inlined) because pi's extension loader can run from packaged
    // binaries whose module resolution cannot trace this package's
    // node_modules. No shebang banner: pi parses this as a module.
    entry: { 'mcp-bridge/extension': 'src/mcp-bridge/extension.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: false,
    dts: false,
    splitting: false,
    minify: false,
    noExternal: [/.*/],
    // Inlined CJS deps (e.g. cross-spawn) call require(); expose one for the ESM bundle.
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    }
  }
])

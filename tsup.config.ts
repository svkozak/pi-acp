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
    // Self-contained pi extension loaded via `pi -e` when a session carries
    // mcpServers. The MCP SDK is bundled so the file works regardless of where
    // pi resolves node_modules (pi-acp may be a transitive/bundled dep).
    entry: { 'pi-mcp-extension': 'src/mcp/pi-mcp-extension.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    clean: false,
    dts: false,
    splitting: false,
    minify: false,
    noExternal: [/^@modelcontextprotocol\/sdk/]
  }
])

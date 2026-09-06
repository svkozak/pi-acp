import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Resolve the MCP bridge extension file the spawned pi should load with `-e`.
 *
 * Built package (`dist/index.js`): the self-contained bundle is emitted next
 * to it at `dist/mcp-bridge/extension.js`. Dev (`npm run dev`, tsx): this
 * module's own URL points at `src/mcp-bridge/`, so the TypeScript sibling is
 * what pi's jiti loader picks up.
 */
export function getMcpBridgeExtensionPath(): string {
  const candidates = [new URL('./mcp-bridge/extension.js', import.meta.url), new URL('./extension.ts', import.meta.url)]
  for (const url of candidates) {
    const path = fileURLToPath(url)
    if (existsSync(path)) return path
  }
  return fileURLToPath(candidates[0]!)
}

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@agentclientprotocol/sdk'

export const PI_ACP_MCP_SERVERS_ENV = 'PI_ACP_MCP_SERVERS'

/** Serialized subset of ACP McpServer consumed by the bundled pi extension. */
export type PiAcpMcpServerSpec = {
  name: string
  type?: 'http' | 'sse' | 'acp'
  command?: string
  args?: string[]
  env?: Array<{ name: string; value: string }>
  url?: string
  headers?: Array<{ name: string; value: string }>
}

/**
 * Convert ACP `session/new` mcpServers into the JSON payload the bundled pi
 * extension reads from PI_ACP_MCP_SERVERS. Unknown/malformed entries are dropped.
 */
export function serializeMcpServers(servers: McpServer[] | undefined): PiAcpMcpServerSpec[] {
  const out: PiAcpMcpServerSpec[] = []
  for (const server of servers ?? []) {
    if (!server || typeof server !== 'object' || typeof server.name !== 'string' || !server.name) continue

    const type = (server as { type?: string }).type
    if (type === 'http' || type === 'sse') {
      const url = (server as { url?: unknown }).url
      if (typeof url !== 'string' || !url) continue
      out.push({
        name: server.name,
        type,
        url,
        headers: Array.isArray((server as { headers?: unknown }).headers)
          ? ((server as { headers: Array<{ name: string; value: string }> }).headers ?? [])
          : []
      })
      continue
    }

    if (type === 'acp') {
      // ACP-transport MCP needs the client's mcp/* channel; unsupported for now.
      out.push({ name: server.name, type: 'acp' })
      continue
    }

    // stdio (default shape: no `type` discriminator)
    const command = (server as { command?: unknown }).command
    if (typeof command !== 'string' || !command) continue
    out.push({
      name: server.name,
      command,
      args: Array.isArray((server as { args?: unknown }).args) ? (server as { args: string[] }).args.map(String) : [],
      env: Array.isArray((server as { env?: unknown }).env)
        ? ((server as { env: Array<{ name: string; value: string }> }).env ?? [])
        : []
    })
  }
  return out
}

/**
 * Absolute path to the bundled pi extension file.
 * Packaged: dist/pi-mcp-extension.js sits next to the bundled index.js.
 * Dev (tsx): this file lives next to the extension TS source, which pi loads
 * via jiti — imports of @modelcontextprotocol/sdk resolve from the repo's
 * node_modules.
 */
export function resolveMcpExtensionPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(here, 'pi-mcp-extension.js'), join(here, 'pi-mcp-extension.ts')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

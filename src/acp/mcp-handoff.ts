import { RequestError, type McpServer } from '@agentclientprotocol/sdk'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Env var carrying the session/new MCP handoff into the pi child. */
export const MCP_SERVERS_ENV = 'PI_ACP_MCP_SERVERS'

/** A session/new array is small; anything bigger is a client bug, refused loudly. */
const MAX_HANDOFF_BYTES = 256 * 1024

export interface McpHandoffEntry {
  name: string
  config: Record<string, unknown>
}

// ACP session/new elements carry stdio {command, args, env} or HTTP {url, headers}.
// pi serves those two transports; SSE and ACP-transport elements have nowhere to
// mount, so they refuse the session instead of running one whose tools never arrive.
export function toPiMcpHandoff(servers: McpServer[]): McpHandoffEntry[] {
  const entries: McpHandoffEntry[] = []
  for (const server of servers) {
    if ('command' in server) {
      const env: Record<string, string> = {}
      for (const entry of server.env ?? []) env[entry.name] = entry.value
      entries.push({ name: server.name, config: { command: server.command, args: server.args ?? [], env } })
    } else if (server.type === 'http') {
      const headers: Record<string, string> = {}
      for (const entry of server.headers ?? []) headers[entry.name] = entry.value
      entries.push({ name: server.name, config: { type: 'http', url: server.url, headers } })
    } else {
      throw RequestError.invalidParams(
        {},
        `Unsupported MCP server "${server.name}" on session/new: pi serves stdio and HTTP transports only`
      )
    }
  }
  const raw = JSON.stringify(entries)
  if (raw.length > MAX_HANDOFF_BYTES) {
    throw RequestError.invalidParams({}, `MCP handoff too large (${raw.length} bytes, cap ${MAX_HANDOFF_BYTES})`)
  }
  return entries
}

/** Spawn additions mounting the handoff, or {} when there is nothing to mount. */
export function handoffSpawnArgs(servers: McpServer[]): {
  env?: Record<string, string>
  extraArgs?: string[]
} {
  const entries = toPiMcpHandoff(servers)
  if (entries.length === 0) return {}
  return {
    env: { [MCP_SERVERS_ENV]: JSON.stringify(entries) },
    extraArgs: ['--extension', mcpBridgePath()]
  }
}

/** Absolute path of the bundled bridge extension, in dist/ and src/ layouts. */
export function mcpBridgePath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, 'pi-mcp-bridge.js'),
    join(here, 'acp', 'pi-mcp-bridge.js'),
    join(here, 'pi-mcp-bridge.ts')
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw RequestError.internalError({}, 'Bundled MCP bridge extension not found alongside pi-acp')
}

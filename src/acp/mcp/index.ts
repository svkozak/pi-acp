/**
 * McpManager: per-session orchestrator that wires ACP-provided MCP servers
 * through to pi.
 *
 * pi has no native MCP support; the community `pi-mcp-adapter` extension reads
 * MCP server config from `.pi/mcp.json` (among other paths). This manager:
 *
 *   - Translates stdio/http/sse ACP servers into pi-mcp-adapter config entries
 *     and merges them into the project-local `.pi/mcp.json`.
 *   - For ACP-transport (`type: "acp"`) servers, spins up the shim/socket bridge
 *     and emits corresponding stdio config entries so pi launches the shim.
 *
 * Requires the `pi-mcp-adapter` extension to be installed in pi for pi to
 * actually connect to these servers. If it is not installed, the config is
 * still written harmlessly; pi simply won't read it.
 */
import type { AgentSideConnection, McpServer } from '@agentclientprotocol/sdk'
import {
  acpMcpServerToPiConfig,
  writeManagedMcpConfig,
  type ManagedMcpConfig,
  type PiMcpServerConfig
} from './config.js'
import { AcpMcpBridge } from './bridge.js'

export interface McpSetupResult {
  /** Restore the project `.pi/mcp.json` to its prior state. */
  restore: () => void
  /** The bridge (only present when there is at least one ACP-transport server). */
  bridge: AcpMcpBridge | null
}

/**
 * Partition ACP MCP servers by transport and prepare pi-side wiring.
 *
 * Returns the managed pi-mcp-adapter config entries to write, plus the bridge
 * that owns the ACP-transport shim sockets (so the caller can dispose it later
 * and route inbound ACP messages).
 */
export async function setupMcpServers(
  conn: AgentSideConnection,
  cwd: string,
  servers: McpServer[]
): Promise<McpSetupResult> {
  const acpServers = servers.filter((s): s is Extract<McpServer, { type: 'acp' }> => 'type' in s && s.type === 'acp')

  let bridge: AcpMcpBridge | null = null
  const managed: Record<string, PiMcpServerConfig> = {}

  for (const server of servers) {
    if ('type' in server && server.type === 'acp') {
      if (!bridge) bridge = new AcpMcpBridge(conn)
      const shimEntry = await bridge.addServer({ name: server.name, acpId: server.id })
      // Names must be unique within .pi/mcp.json; if an ACP server collides with
      // a user-managed server name, the ACP one wins for this session (it's
      // restored on dispose).
      managed[server.name] = {
        command: shimEntry.command,
        args: shimEntry.args,
        env: shimEntry.env
      }
    } else {
      const cfg = acpMcpServerToPiConfig(server)
      if (cfg) managed[server.name] = cfg
    }
  }

  void acpServers // (acpServers used implicitly via the loop above)
  const managedConfig: ManagedMcpConfig = writeManagedMcpConfig(cwd, managed)

  return {
    restore: managedConfig.restore,
    bridge
  }
}

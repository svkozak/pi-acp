import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { MCP_SERVERS_ENV, parseBridgeServers, toBridgePlan, type BridgeServerPlan } from './servers.js'
import { registerBridgeTools } from './wire.js'

function transportFor(plan: BridgeServerPlan): Transport {
  switch (plan.kind) {
    case 'stdio':
      return new StdioClientTransport({ command: plan.command, args: plan.args, env: plan.env })
    case 'http':
      return new StreamableHTTPClientTransport(new URL(plan.url), { requestInit: { headers: plan.headers } })
    case 'sse':
      return new SSEClientTransport(new URL(plan.url), { requestInit: { headers: plan.headers } })
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * The pi side of the adapter's MCP support: the ACP session's `mcpServers`
 * arrive in this process's env (MCP_SERVERS_ENV), and each server becomes pi
 * tools named `${server}_${tool}` via one MCP client per server. Built to a
 * single self-contained file (see tsup.config.ts) so any pi build can load it
 * with `-e`.
 */
export default function piAcpMcpBridge(pi: ExtensionAPI): void {
  const servers = parseBridgeServers(process.env[MCP_SERVERS_ENV])
  if (servers.length === 0) return

  const clients: Client[] = []

  pi.on('session_start', async (_event, ctx) => {
    // Servers connect in parallel; each one's failure is its own notice
    // rather than one broken server taking the others with it.
    await Promise.all(
      servers.map(async server => {
        const plan = toBridgePlan(server)
        if (plan === null) {
          ctx.ui.notify(`[mcp] ${server?.name ?? '?'}: unsupported server transport; skipping`, 'warning')
          return
        }
        const client = new Client({ name: `pi-acp-${plan.server}`, version: '0.0.0' })
        try {
          await client.connect(transportFor(plan))
        } catch (error) {
          ctx.ui.notify(`[mcp] ${plan.server}: failed to connect — ${errorText(error)}`, 'error')
          return
        }
        clients.push(client)
        try {
          await registerBridgeTools(pi, client, plan)
        } catch (error) {
          ctx.ui.notify(`[mcp] ${plan.server}: connected, but failed to list tools — ${errorText(error)}`, 'error')
        }
      })
    )
  })

  pi.on('session_shutdown', async () => {
    await Promise.all(clients.map(client => client.close().catch(() => {})))
    clients.length = 0
  })
}

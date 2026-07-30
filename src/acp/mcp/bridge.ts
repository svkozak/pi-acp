/**
 * MCP-over-ACP transport bridge.
 *
 * Implements the `acp` MCP transport from the MCP-over-ACP RFD
 * (https://agentclientprotocol.com/rfds/mcp-over-acp). ACP-transport MCP
 * servers are provided by the client and communicate over the ACP channel
 * itself (no stdio/HTTP). Because pi only speaks stdio MCP (via pi-mcp-adapter),
 * this bridge presents each ACP-transport server to pi as a local stdio MCP
 * server (the `mcp-shim` process) and relays messages between that shim and the
 * client over the ACP channel using `mcp/connect`, `mcp/message`, and
 * `mcp/disconnect`.
 *
 * Message flow (per ACP-transport server):
 *   - The bridge owns a local socket server (one per server).
 *   - pi (via pi-mcp-adapter) spawns the shim, which connects to the socket.
 *   - On socket connect, the bridge sends an ACP `mcp/connect` request (with the
 *     server's `acpId`) and records the returned `connectionId`.
 *   - Newline-delimited JSON-RPC lines from the shim are wrapped as
 *     `mcp/message` requests/notifications and sent to the client.
 *   - Server-originated *notifications* from the client (`mcp/message` directed
 *     at this connectionId) are written back to the shim so pi's MCP client
 *     sees them. Server-originated *requests* (e.g. sampling/createMessage) are
 *     declined, since they would require pi's MCP client to also act as a server.
 *   - On teardown (or socket close), the bridge sends `mcp/disconnect`.
 */
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { PathLike, unlinkSync } from 'node:fs'

/**
 * A stdio MCP server entry (pi-mcp-adapter format) that pi will spawn.
 * Returned so the `McpManager` can merge it into `.pi/mcp.json`.
 */
export interface StdioShimEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

type AcpServerInfo = {
  /** Human-readable name from session/new. */
  name: string
  /** Component-provided id from `McpServerAcp.id`. */
  acpId: string
}

type ActiveConnection = {
  /** ACP connection id (client-assigned on mcp/connect, or pre-generated). */
  connectionId: string
  socket: Socket
  /** Lines received from the shim before mcp/connect resolved. */
  pendingLines: string[]
  connected: boolean
}

/**
 * Timeouts for ACP round-trips. Without these, an unresponsive client would
 * leave pi's MCP requests pending forever (the shim has no protocol awareness
 * and cannot fail them itself).
 */
export interface AcpMcpBridgeTimeouts {
  /** `mcp/connect` — session setup, should be fast. */
  connectMs: number
  /** `mcp/message` requests — generous: MCP tool calls can be long-running. */
  messageMs: number
  /** `mcp/disconnect` — best-effort teardown. */
  disconnectMs: number
}

const DEFAULT_TIMEOUTS: AcpMcpBridgeTimeouts = {
  connectMs: 15_000,
  messageMs: 300_000,
  disconnectMs: 5_000
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/** Path to the built shim script, resolved relative to this module. */
function resolveShimPath(): string {
  const here = fileURLToPath(import.meta.url)
  const isWin = process.platform === 'win32'
  const sep = isWin ? '\\' : '/'
  const segments = here.split(/[/\\]/)
  const distIdx = segments.lastIndexOf('dist')
  if (distIdx >= 0) {
    return [...segments.slice(0, distIdx), 'dist', 'mcp-shim.js'].join(sep)
  }
  // Dev mode (tsx): src/acp/mcp/bridge.ts -> src/mcp-shim.ts
  const srcIdx = segments.lastIndexOf('src')
  if (srcIdx >= 0) {
    return [...segments.slice(0, srcIdx), 'src', 'mcp-shim.ts'].join(sep)
  }
  return join(process.cwd(), 'mcp-shim.js')
}

export class AcpMcpBridge {
  private readonly conn: AgentSideConnection
  private readonly timeouts: AcpMcpBridgeTimeouts
  /** connectionId -> connection state. */
  private readonly connections = new Map<string, ActiveConnection>()
  /** socket server -> server context (acp info + socket path). */
  private readonly servers = new Map<Server, { info: AcpServerInfo; socketPath: string }>()
  private disposed = false

  constructor(conn: AgentSideConnection, timeouts: Partial<AcpMcpBridgeTimeouts> = {}) {
    this.conn = conn
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts }
  }

  /**
   * Set up bridging for a single ACP-transport MCP server. Returns the stdio
   * shim entry that should be registered in pi's MCP config so pi launches it.
   */
  async addServer(server: AcpServerInfo): Promise<StdioShimEntry> {
    const socketPath = makeSocketPath(server.acpId)

    const serverSocket = createServer(client => {
      this.handleShimConnection(client, server)
    })

    await removePath(socketPath)
    await new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err)
      serverSocket.once('error', onError)
      serverSocket.listen(socketPath, () => {
        serverSocket.off('error', onError)
        resolve()
      })
    })

    this.servers.set(serverSocket, { info: server, socketPath })
    serverSocket.on('error', () => {
      // Ignore server-level errors after listen; individual sockets manage themselves.
    })

    return {
      command: process.execPath,
      args: [resolveShimPath()],
      env: { PI_ACP_MCP_SOCKET: socketPath }
    }
  }

  private handleShimConnection(socket: Socket, server: AcpServerInfo): void {
    let buffer = ''
    const connectionId = randomUUID()
    const active: ActiveConnection = {
      connectionId,
      socket,
      pendingLines: [],
      connected: false
    }
    this.connections.set(connectionId, active)

    void this.connect(server.acpId, active)

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf-8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line.trim()) this.handleShimLine(active, line)
      }
    })

    socket.on('close', () => this.cleanupConnection(active))
    socket.on('error', () => this.cleanupConnection(active))
  }

  private async connect(acpId: string, active: ActiveConnection): Promise<void> {
    try {
      const res = (await withTimeout(
        this.conn.extMethod('mcp/connect', { acpId }),
        this.timeouts.connectMs,
        'mcp/connect'
      )) as { connectionId?: string } | undefined
      if (res && typeof res.connectionId === 'string' && res.connectionId) {
        // Re-key under the client-assigned connection id.
        this.connections.delete(active.connectionId)
        active.connectionId = res.connectionId
        this.connections.set(active.connectionId, active)
      }
      active.connected = true
      const queued = active.pendingLines.splice(0)
      for (const line of queued) void this.dispatchShimLine(active, line)
    } catch {
      // If connect fails, drop the connection; the shim exits and pi sees the
      // server as unavailable.
      this.connections.delete(active.connectionId)
      active.socket.destroy()
    }
  }

  private handleShimLine(active: ActiveConnection, line: string): void {
    if (!active.connected) {
      active.pendingLines.push(line)
      return
    }
    void this.dispatchShimLine(active, line)
  }

  private async dispatchShimLine(active: ActiveConnection, line: string): Promise<void> {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg == null || typeof msg !== 'object') return
    const innerMethod = typeof msg.method === 'string' ? msg.method : undefined
    if (!innerMethod) return

    const innerParams = msg.params ?? undefined
    const isRequest = msg.id !== undefined && msg.id !== null

    if (isRequest) {
      const id = msg.id
      try {
        const result = (await withTimeout(
          this.conn.extMethod('mcp/message', {
            connectionId: active.connectionId,
            method: innerMethod,
            params: innerParams ?? null
          }),
          this.timeouts.messageMs,
          `mcp/message (${innerMethod})`
        )) as unknown
        this.writeToShim(active, { jsonrpc: '2.0', id, result: result ?? null })
      } catch (err: any) {
        this.writeToShim(active, {
          jsonrpc: '2.0',
          id,
          error: {
            code: typeof err?.code === 'number' ? err.code : -32603,
            message: err?.message ?? 'mcp/message failed'
          }
        })
      }
    } else {
      try {
        await this.conn.extNotification('mcp/message', {
          connectionId: active.connectionId,
          method: innerMethod,
          params: innerParams ?? null
        })
      } catch {
        // best-effort
      }
    }
  }

  private writeToShim(active: ActiveConnection, obj: unknown): void {
    if (active.socket.destroyed) return
    try {
      active.socket.write(`${JSON.stringify(obj)}\n`)
    } catch {
      // ignore
    }
  }

  /** Whether this bridge owns a given ACP connectionId. */
  hasConnection(connectionId: string): boolean {
    return this.connections.has(connectionId)
  }

  /**
   * Handle an inbound `mcp/message` coming from the client (server-originated).
   *
   * Notifications are forwarded to pi by writing them to the shim socket.
   * Requests are declined with a JSON-RPC error by returning an error result;
   * pi-acp cannot satisfy server-originated requests (e.g. sampling) because
   * that would require pi's MCP client to act as an MCP server.
   *
   * Returns `true` if a matching connection was found (so the caller knows the
   * message was handled, even if declined).
   */
  handleInbound(
    connectionId: string,
    method: string,
    params: unknown,
    isRequest: boolean
  ): { handled: boolean; result?: unknown; error?: { code: number; message: string } } {
    const active = this.connections.get(connectionId)
    if (!active) return { handled: false }

    if (!isRequest) {
      this.writeToShim(active, { jsonrpc: '2.0', method, params: params ?? undefined })
      return { handled: true }
    }

    // Decline server-originated requests.
    return {
      handled: true,
      error: {
        code: -32601,
        message: `Server-originated MCP request '${method}' is not supported by pi-acp`
      }
    }
  }

  /** Dispose all servers and connections. Sends `mcp/disconnect` best-effort. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    const disconnects: Promise<void>[] = []
    for (const [, active] of this.connections) {
      disconnects.push(this.disconnect(active))
    }
    await Promise.allSettled(disconnects)

    for (const [server, ctx] of this.servers) {
      try {
        server.close()
      } catch {
        // ignore
      }
      removePathSync(ctx.socketPath)
    }
    this.servers.clear()
    this.connections.clear()
  }

  private async disconnect(active: ActiveConnection): Promise<void> {
    try {
      await withTimeout(
        this.conn.extMethod('mcp/disconnect', { connectionId: active.connectionId }),
        this.timeouts.disconnectMs,
        'mcp/disconnect'
      )
    } catch {
      // best-effort
    }
    try {
      active.socket.destroy()
    } catch {
      // ignore
    }
  }

  private cleanupConnection(active: ActiveConnection): void {
    if (this.disposed) return
    this.connections.delete(active.connectionId)
    // Tell the client this connection is gone. Per the SDK schema,
    // mcp/disconnect is a request (has a response), not a notification.
    void withTimeout(
      this.conn.extMethod('mcp/disconnect', { connectionId: active.connectionId }),
      this.timeouts.disconnectMs,
      'mcp/disconnect'
    ).catch(() => {})
  }
}

function makeSocketPath(acpId: string): string {
  const safe = acpId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || randomUUID()
  const name = `pi-acp-mcp-${safe}-${randomUUID().slice(0, 8)}`
  // Windows has no unix domain sockets; net.Server.listen() needs a named pipe.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${name}`
  }
  // Unix domain socket paths have a length limit (~104 chars on macOS). tmpdir
  // keeps us comfortably under that limit.
  return join(tmpdir(), `${name}.sock`)
}

function removePath(p: PathLike): Promise<void> {
  return new Promise(resolve => {
    try {
      unlinkSync(p)
    } catch {
      // ignore
    }
    resolve()
  })
}

function removePathSync(p: PathLike): void {
  try {
    unlinkSync(p)
  } catch {
    // ignore
  }
}

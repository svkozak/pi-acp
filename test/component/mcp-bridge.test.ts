import test from 'node:test'
import assert from 'node:assert/strict'
import { AcpMcpBridge } from '../../src/acp/mcp/bridge.js'
import { setupMcpServers } from '../../src/acp/mcp/index.js'
import type { AgentSideConnection, McpServer } from '@agentclientprotocol/sdk'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A fake AgentSideConnection that records outgoing extMethod/extNotification
 * calls and lets the test script the responses.
 */
class FakeConn {
  readonly calls: Array<{ kind: 'method' | 'notification'; method: string; params: any }> = []
  /** Responder for extMethod(method, params) -> result. */
  responder: (method: string, params: any) => any = () => ({ ok: true })

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ kind: 'method', method, params })
    const r = this.responder(method, params)
    return r as Record<string, unknown>
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.calls.push({ kind: 'notification', method, params })
  }
}

/** Connect a raw socket to the bridge's shim socket and exchange NDJSON. */
async function connectShim(env: Record<string, string>): Promise<{
  send: (obj: any) => void
  nextResponse: () => Promise<any>
  close: () => void
}> {
  const sock = createConnection({ path: env.PI_ACP_MCP_SOCKET })
  sock.setEncoding('utf-8')
  let buffer = ''
  const pending: any[] = []
  sock.on('data', (chunk: string) => {
    buffer += chunk
    let nl: number
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, '')
      buffer = buffer.slice(nl + 1)
      if (line.trim()) {
        try {
          pending.push(JSON.parse(line))
        } catch {
          // ignore
        }
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })

  return {
    send(obj: any) {
      sock.write(`${JSON.stringify(obj)}\n`)
    },
    async nextResponse() {
      const deadline = Date.now() + 2000
      while (pending.length === 0) {
        if (Date.now() > deadline) throw new Error('timeout waiting for shim response')
        await delay(10)
      }
      return pending.shift()
    },
    close() {
      sock.destroy()
    }
  }
}

test('AcpMcpBridge: connect + tools/call round-trips through mcp/message', async () => {
  const conn = new FakeConn()
  let connectionIdSeen: string | null = null
  conn.responder = (method, params) => {
    if (method === 'mcp/connect') return { connectionId: 'conn-1' }
    if (method === 'mcp/message') {
      connectionIdSeen = params.connectionId
      if (params.method === 'tools/call') {
        return { content: [{ type: 'text', text: `called ${params.params?.name}` }] }
      }
      return {}
    }
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection)
  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-123' })

  const shim = await connectShim(entry.env)

  // Wait for mcp/connect to complete (the bridge fires it on socket connect).
  await delay(50)

  // Send a tools/call request from the shim (pi side).
  shim.send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'greet' } })
  const resp = await shim.nextResponse()

  assert.equal(resp.id, 10)
  assert.equal(resp.result.content[0].text, 'called greet')
  assert.equal(connectionIdSeen, 'conn-1')

  shim.close()
  await bridge.dispose()
})

test('AcpMcpBridge: notifications use extNotification (no response sent)', async () => {
  const conn = new FakeConn()
  conn.responder = (method, _params) => {
    if (method === 'mcp/connect') return { connectionId: 'conn-2' }
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection)
  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-notif' })
  const shim = await connectShim(entry.env)
  await delay(50)

  const before = conn.calls.length
  shim.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 0.5 } })
  await delay(50)

  const notif = conn.calls.find(c => c.method === 'mcp/message' && c.params?.method === 'notifications/progress')
  assert.ok(notif, 'notification forwarded as mcp/message notification')

  // Should not have produced a response on the shim.
  // (No id on the notification -> no response line expected.)
  void before

  shim.close()
  await bridge.dispose()
})

test('AcpMcpBridge: inbound notification (server-originated) is forwarded to shim', async () => {
  const conn = new FakeConn()
  conn.responder = method => {
    if (method === 'mcp/connect') return { connectionId: 'conn-3' }
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection)
  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-inbound' })
  const shim = await connectShim(entry.env)
  await delay(50)

  const handled = bridge.handleInbound('conn-3', 'notifications/resources/updated', { uri: 'file:///x' }, false)
  assert.equal(handled.handled, true)

  const msg = await shim.nextResponse()
  assert.equal(msg.method, 'notifications/resources/updated')
  assert.equal(msg.params.uri, 'file:///x')

  shim.close()
  await bridge.dispose()
})

test('AcpMcpBridge: mcp/message rejection produces a JSON-RPC error response', async () => {
  const conn = new FakeConn()
  conn.responder = method => {
    if (method === 'mcp/connect') return { connectionId: 'conn-err' }
    if (method === 'mcp/message') throw new Error('client exploded')
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection)
  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-err' })
  const shim = await connectShim(entry.env)
  await delay(50)

  shim.send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'boom' } })
  const resp = await shim.nextResponse()

  assert.equal(resp.id, 20)
  assert.ok(resp.error, 'rejected request surfaces a JSON-RPC error to pi')
  assert.match(String(resp.error.message), /client exploded/)

  shim.close()
  await bridge.dispose()
})

test('AcpMcpBridge: unresponsive client times out mcp/message instead of hanging pi', async () => {
  const conn = new FakeConn()
  conn.responder = method => {
    if (method === 'mcp/connect') return { connectionId: 'conn-hang' }
    if (method === 'mcp/message') return new Promise(() => {}) // never resolves
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection, { messageMs: 100 })
  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-hang' })
  const shim = await connectShim(entry.env)
  await delay(50)

  shim.send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'slow' } })
  const resp = await shim.nextResponse()

  assert.equal(resp.id, 30)
  assert.ok(resp.error, 'timed-out request surfaces a JSON-RPC error to pi')
  assert.match(String(resp.error.message), /timed out/)

  shim.close()
  await bridge.dispose()
})

test('AcpMcpBridge: unresponsive client times out mcp/connect and drops the shim connection', async () => {
  const conn = new FakeConn()
  conn.responder = method => {
    if (method === 'mcp/connect') return new Promise(() => {}) // never resolves
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection, { connectMs: 100 })
  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-cto' })

  const sock = createConnection({ path: entry.env.PI_ACP_MCP_SOCKET })
  const closed = new Promise<void>(resolve => sock.once('close', resolve))
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })

  // The bridge should destroy the socket once mcp/connect times out.
  const timeout = delay(2000).then(() => {
    throw new Error('socket was not closed after mcp/connect timeout')
  })
  await Promise.race([closed, timeout])

  await bridge.dispose()
})

test('AcpMcpBridge: shim socket close sends mcp/disconnect as a request', async () => {
  const conn = new FakeConn()
  conn.responder = method => {
    if (method === 'mcp/connect') return { connectionId: 'conn-close' }
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection)
  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-close' })
  const shim = await connectShim(entry.env)
  await delay(50)

  shim.close()
  await delay(50)

  const disconnect = conn.calls.find(c => c.method === 'mcp/disconnect')
  assert.ok(disconnect, 'mcp/disconnect sent when the shim connection drops')
  assert.equal(disconnect.kind, 'method', 'mcp/disconnect is a request per the SDK schema, not a notification')
  assert.equal(disconnect.params.connectionId, 'conn-close')

  await bridge.dispose()
})

test('setupMcpServers: a failing acp server does not take down the other servers', async t => {
  if (process.platform === 'win32') {
    t.skip('TMPDIR-based socket failure injection is POSIX-only')
    return
  }

  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-setup-'))
  const originalTmpdir = process.env.TMPDIR
  // Point tmpdir at a nonexistent directory so the acp server's socket listen
  // fails, while everything else keeps working.
  process.env.TMPDIR = join(cwd, 'does-not-exist')

  try {
    const servers: McpServer[] = [
      { type: 'acp', name: 'broken-acp', id: 'broken-id' } as McpServer,
      { type: 'http', name: 'remote', url: 'https://example.com/mcp', headers: [] } as McpServer
    ]

    const conn = new FakeConn()
    const setup = await setupMcpServers(conn as unknown as AgentSideConnection, cwd, servers)

    const configPath = join(cwd, '.pi', 'mcp.json')
    assert.ok(existsSync(configPath), 'config still written despite the broken acp server')
    const data = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepEqual(data.mcpServers.remote, { type: 'http', url: 'https://example.com/mcp' })
    assert.ok(!('broken-acp' in data.mcpServers), 'broken acp server skipped')

    setup.restore()
    assert.ok(!existsSync(configPath), 'restore removes the managed config')
    await setup.bridge?.dispose()
  } finally {
    if (originalTmpdir == null) delete process.env.TMPDIR
    else process.env.TMPDIR = originalTmpdir
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('AcpMcpBridge: hasConnection reflects connect state', async () => {
  const conn = new FakeConn()
  conn.responder = (method, _params) => {
    if (method === 'mcp/connect') return { connectionId: 'conn-4' }
    return {}
  }

  const bridge = new AcpMcpBridge(conn as unknown as AgentSideConnection)
  assert.equal(bridge.hasConnection('conn-4'), false)

  const entry = await bridge.addServer({ name: 'acp-tools', acpId: 'acp-id-has' })
  const shim = await connectShim(entry.env)
  await delay(50)

  assert.equal(bridge.hasConnection('conn-4'), true)

  shim.close()
  await delay(30)
  await bridge.dispose()
})

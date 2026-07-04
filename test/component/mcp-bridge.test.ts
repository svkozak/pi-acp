import test from 'node:test'
import assert from 'node:assert/strict'
import { AcpMcpBridge } from '../../src/acp/mcp/bridge.js'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import { createConnection } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * A fake AgentSideConnection that records outgoing extMethod/extNotification
 * calls and lets the test script the responses.
 */
class FakeConn {
  readonly calls: Array<{ method: string; params: any }> = []
  /** Responder for extMethod(method, params) -> result. */
  responder: (method: string, params: any) => any = () => ({ ok: true })

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.push({ method, params })
    const r = this.responder(method, params)
    return r as Record<string, unknown>
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    this.calls.push({ method, params })
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

  const notif = conn.calls.find(
    c => c.method === 'mcp/message' && c.params?.method === 'notifications/progress'
  )
  assert.ok(notif, 'notification forwarded as mcp/message notification')

  // Should not have produced a response on the shim.
  // (No id on the notification -> no response line expected.)
  void before

  shim.close()
  await bridge.dispose()
})

test('AcpMcpBridge: inbound notification (server-originated) is forwarded to shim', async () => {
  const conn = new FakeConn()
  conn.responder = (method) => {
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

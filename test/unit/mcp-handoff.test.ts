import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import bridge from '../../src/acp/pi-mcp-bridge.js'
import { MCP_SERVERS_ENV, handoffSpawnArgs, mcpBridgePath, toPiMcpHandoff } from '../../src/acp/mcp-handoff.js'

// pi#11067 companion, extension-bridge shape: the session/new array travels as
// env into a bundled --extension instead of a core RPC command.

test('toPiMcpHandoff translates stdio and HTTP elements', () => {
  assert.deepEqual(
    toPiMcpHandoff([
      { name: 'probe', command: '/bin/echo', args: ['hi'], env: [{ name: 'A', value: 'b' }] },
      { name: 'web', type: 'http', url: 'https://example.com/mcp', headers: [{ name: 'H', value: 'v' }] }
    ] as any),
    [
      { name: 'probe', config: { command: '/bin/echo', args: ['hi'], env: { A: 'b' } } },
      { name: 'web', config: { type: 'http', url: 'https://example.com/mcp', headers: { H: 'v' } } }
    ]
  )
})

test('toPiMcpHandoff refuses SSE and ACP-transport elements', () => {
  for (const server of [
    { name: 'stream', type: 'sse', url: 'https://example.com/sse', headers: [] },
    { name: 'chan', type: 'acp', id: 'x' }
  ]) {
    let threw = false
    try {
      toPiMcpHandoff([server] as any)
    } catch (e: any) {
      threw = true
      assert.equal(e?.code, -32602)
      assert.match(String(e?.data?.message ?? e?.message ?? e), /stdio and HTTP/i)
    }
    assert.equal(threw, true)
  }
})

test('handoffSpawnArgs is empty without servers and points at a real bridge file otherwise', () => {
  assert.deepEqual(handoffSpawnArgs([]), {})
  const args = handoffSpawnArgs([{ name: 'probe', command: '/bin/echo', args: [], env: [] }] as any)
  assert.equal(args.extraArgs?.[0], '--extension')
  const bridge = args.extraArgs?.[1] ?? ''
  assert.equal(existsSync(bridge), true)
  const entries = JSON.parse(args.env?.[MCP_SERVERS_ENV] ?? '[]')
  assert.deepEqual(entries, [{ name: 'probe', config: { command: '/bin/echo', args: [], env: {} } }])
})

test('bridge registers handoff entries and ignores a missing handoff', () => {
  const registered: Array<{ name: string; config: unknown }> = []
  const saved = process.env[MCP_SERVERS_ENV]
  try {
    delete process.env[MCP_SERVERS_ENV]
    const record = (name: string, config: unknown): void => {
      registered.push({ name, config })
    }
    bridge({ registerMcpServer: record })
    assert.equal(registered.length, 0)
    process.env[MCP_SERVERS_ENV] = JSON.stringify([{ name: 'a', config: { command: 'x' } }])
    bridge({ registerMcpServer: record })
    assert.deepEqual(registered, [{ name: 'a', config: { command: 'x' } }])
  } finally {
    if (saved === undefined) delete process.env[MCP_SERVERS_ENV]
    else process.env[MCP_SERVERS_ENV] = saved
  }
})

test('bridge fails loudly on a malformed handoff', () => {
  const saved = process.env[MCP_SERVERS_ENV]
  try {
    for (const raw of ['{nope', '[1]', '[{"name":"","config":{}}]', '[{"name":"a"}]']) {
      process.env[MCP_SERVERS_ENV] = raw
      assert.throws(() => bridge({ registerMcpServer: () => {} }), /PI_ACP_MCP_SERVERS/)
    }
  } finally {
    if (saved === undefined) delete process.env[MCP_SERVERS_ENV]
    else process.env[MCP_SERVERS_ENV] = saved
  }
})

test('mcpBridgePath resolves inside the repo', () => {
  assert.equal(existsSync(mcpBridgePath()), true)
})

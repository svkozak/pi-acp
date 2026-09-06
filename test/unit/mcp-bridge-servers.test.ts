import test from 'node:test'
import assert from 'node:assert/strict'
import type { McpServer } from '@agentclientprotocol/sdk'
import { bridgeToolName, parseBridgeServers, schemaToTypebox, toBridgePlan } from '../../src/mcp-bridge/servers.js'

test('toBridgePlan: stdio server maps command/args and env pairs to a record', () => {
  const plan = toBridgePlan({
    name: 'kolu',
    command: 'npx',
    args: ['-y', '@kolu/client'],
    env: [{ name: 'KOLU_SESSION', value: 's1' }, { name: 'BROKEN' } as never]
  })

  assert.deepEqual(plan, {
    kind: 'stdio',
    server: 'kolu',
    command: 'npx',
    args: ['-y', '@kolu/client'],
    env: { KOLU_SESSION: 's1' }
  })
})

test('toBridgePlan: http and sse servers map url and header pairs to records', () => {
  assert.deepEqual(toBridgePlan({ name: 'olai', type: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] }), {
    kind: 'http',
    server: 'olai',
    url: 'http://127.0.0.1:1/mcp',
    headers: {}
  })

  assert.deepEqual(
    toBridgePlan({
      name: 'events',
      type: 'sse',
      url: 'http://127.0.0.1:2/sse',
      headers: [{ name: 'Authorization', value: 'Bearer t' }]
    }),
    { kind: 'sse', server: 'events', url: 'http://127.0.0.1:2/sse', headers: { Authorization: 'Bearer t' } }
  )
})

test('toBridgePlan: ACP-channel servers and unshaped entries answer null', () => {
  assert.equal(toBridgePlan({ name: 'zed', type: 'acp', id: 'one' }), null)
  assert.equal(toBridgePlan({ name: 'x' } as unknown as McpServer), null)
  assert.equal(toBridgePlan({ name: 'x', type: 'http' } as unknown as McpServer), null)
})

test('bridgeToolName: names arrive unchanged when they fit pi tool names', () => {
  assert.equal(bridgeToolName('olai', 'read_node'), 'olai_read_node')
  assert.equal(bridgeToolName('kolu', 'list_terminals'), 'kolu_list_terminals')
})

test('bridgeToolName: characters outside pi tool names collapse to underscores', () => {
  assert.equal(bridgeToolName('my server', 'do.thing'), 'my_server_do_thing')
})

test('schemaToTypebox: an object keeps required and optional properties', () => {
  const out = schemaToTypebox({
    type: 'object',
    required: ['node'],
    properties: {
      node: { type: 'string', description: "the node's name" },
      under: { type: 'string' }
    }
  }) as any

  assert.equal(out.type, 'object')
  assert.equal(out.properties.node.type, 'string')
  assert.equal(out.properties.node.description, "the node's name")
  assert.deepEqual(out.required, ['node'])
  assert.ok(!('required' in out.properties.under))
  assert.equal(out.properties.under.type, 'string')
})

test('schemaToTypebox: scalars, arrays, and enums map to their typebox shapes', () => {
  const out = schemaToTypebox({
    type: 'object',
    properties: {
      n: { type: 'number' },
      i: { type: 'integer' },
      b: { type: 'boolean' },
      xs: { type: 'array', items: { type: 'string' } },
      pick: { type: 'string', enum: ['a', 'b'] }
    }
  }) as any

  assert.equal(out.properties.n.type, 'number')
  assert.equal(out.properties.i.type, 'integer')
  assert.equal(out.properties.b.type, 'boolean')
  assert.equal(out.properties.xs.type, 'array')
  assert.equal(out.properties.xs.items.type, 'string')
  assert.equal(out.properties.pick.anyOf.length, 2)
  assert.equal(out.properties.pick.anyOf[0].const, 'a')
})

test('schemaToTypebox: shapes no one should guess on fall back to Any', () => {
  assert.equal((schemaToTypebox({ anyOf: [{ type: 'string' }] }) as any).type, undefined)
  assert.equal((schemaToTypebox(null) as any).type, undefined)
  assert.equal((schemaToTypebox({ type: 'string', format: 'date' }) as any).type, 'string')
})

test('parseBridgeServers: what the adapter hands over the env', () => {
  assert.equal(parseBridgeServers('[{"name":"olai","type":"http","url":"http://x/mcp"}]').length, 1)
  assert.deepEqual(parseBridgeServers(''), [])
  assert.deepEqual(parseBridgeServers(undefined), [])
  assert.deepEqual(parseBridgeServers('{broken'), [])
  assert.deepEqual(parseBridgeServers('{"not":"an array"}'), [])
})

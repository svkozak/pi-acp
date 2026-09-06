import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { toBridgePlan } from '../../src/mcp-bridge/servers.js'
import { bridgeAnswerText, registerBridgeTools, type BridgeToolRegistrar } from '../../src/mcp-bridge/wire.js'

// A pi stands the registered definitions up: registerTool remembers, and the
// LLM's tool calls arrive as execute() calls on those definitions.
function fakeRegistrar() {
  const registered = new Map<string, ToolDefinition>()
  const registrar: BridgeToolRegistrar = {
    registerTool(def) {
      registered.set(def.name, def as ToolDefinition)
    }
  }
  return { registrar, registered }
}

test('mcp round trip: a server tool registers under the bridge name and answers a call', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()

  const server = new McpServer({ name: 'fake-olai', version: '0.0.0' })
  server.registerTool(
    'read_node',
    {
      description: 'read a node',
      inputSchema: { node: z.string().describe("the node's name") }
    },
    async args => ({ content: [{ type: 'text', text: `# the node ${args.node} answered` }] })
  )

  const client = new Client({ name: 'pi-acp-olai', version: '0.0.0' })
  await Promise.all([client.connect(clientSide), server.connect(serverSide)])

  const plan = toBridgePlan({ name: 'olai', type: 'http', url: 'http://127.0.0.1:9/mcp', headers: [] })
  assert.ok(plan !== null)

  const { registrar, registered } = fakeRegistrar()
  const names = await registerBridgeTools(registrar, client, plan)

  // the bridged name, not the wire's name:
  assert.deepEqual(names, ['olai_read_node'])
  const def = registered.get('olai_read_node')
  assert.ok(def)

  // the converted schema keeps the string property and its requirement:
  const params = def.parameters as any
  assert.equal(params.properties.node.type, 'string')
  assert.deepEqual(params.required, ['node'])

  // and the call round-trips:
  const result = await def.execute('tc-1', { node: 'install' }, undefined, undefined, {} as never)
  assert.deepEqual(result.content, [{ type: 'text', text: '# the node install answered' }])

  await client.close()
  await server.close()
})

test('mcp round trip: a failing tool surfaces as error text', async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()

  const server = new McpServer({ name: 'fake-kolu', version: '0.0.0' })
  server.registerTool('list_terminals', { description: 'x' }, async () => {
    throw new Error('no session here')
  })

  const client = new Client({ name: 'pi-acp-kolu', version: '0.0.0' })
  await Promise.all([client.connect(clientSide), server.connect(serverSide)])

  const plan = toBridgePlan({ name: 'kolu', command: 'kolu-mcp', args: [], env: [] })
  assert.ok(plan !== null)

  const { registrar, registered } = fakeRegistrar()
  await registerBridgeTools(registrar, client, plan)

  const result = await registered.get('kolu_list_terminals')!.execute('tc-2', {}, undefined, undefined, {} as never)
  assert.match(String(result.content[0] && (result.content[0] as any).text), /The tool answered an error/)
  assert.match(String(result.content[0] && (result.content[0] as any).text), /no session here/)

  await client.close()
  await server.close()
})

test('bridgeAnswerText: names non-text parts and reports empty answers', () => {
  assert.equal(bridgeAnswerText({ content: [{ type: 'image', data: '...', mimeType: 'image/png' }] }), '[image]')
  assert.equal(bridgeAnswerText({ content: [] }), '(the tool answered with no content)')
  assert.equal(bridgeAnswerText({}), '(the tool answered with no content)')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

async function createdWith(clientCapabilities: unknown): Promise<unknown> {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  let seen: unknown = 'unset'
  ;(agent as any).sessions = {
    async create(params: { formElicitation?: boolean }) {
      seen = params.formElicitation
      throw new Error('stop after create')
    },
    close() {},
    dispose() {}
  }

  await agent.initialize({ protocolVersion: 1, clientCapabilities } as any)
  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any).catch(() => {})
  return seen
}

test('PiAcpAgent: passes form elicitation to new sessions when the client advertises it', async () => {
  assert.equal(await createdWith({ elicitation: { form: {} } }), true)
})

test('PiAcpAgent: does not enable forms for url-only or absent elicitation', async () => {
  assert.equal(await createdWith({ elicitation: { url: {} } }), false)
  assert.equal(await createdWith({}), false)
  assert.equal(await createdWith(undefined), false)
})

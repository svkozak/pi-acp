import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

/**
 * `initialize` should record whether the client renders `usage_update` natively,
 * based on `clientInfo.name`. This is later forwarded to `PiAcpSession` to suppress
 * the redundant inline status line.
 */
function getFlag(agent: PiAcpAgent): boolean {
  return (agent as unknown as { clientRendersUsageNatively: boolean }).clientRendersUsageNatively
}

test('initialize: marks clientRendersUsageNatively=true for Zed', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.initialize({ protocolVersion: 1, clientInfo: { name: 'zed' } } as any)
  assert.equal(getFlag(agent), true)
})

test('initialize: is case-insensitive on clientInfo.name', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.initialize({ protocolVersion: 1, clientInfo: { name: 'Zed' } } as any)
  assert.equal(getFlag(agent), true)
})

test('initialize: marks clientRendersUsageNatively=false for unknown clients', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.initialize({ protocolVersion: 1, clientInfo: { name: 'some-other-client' } } as any)
  assert.equal(getFlag(agent), false)
})

test('initialize: defaults to false when clientInfo is absent', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  await agent.initialize({ protocolVersion: 1 } as any)
  assert.equal(getFlag(agent), false)
})

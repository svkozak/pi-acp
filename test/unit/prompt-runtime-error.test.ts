import assert from 'node:assert/strict'
import test from 'node:test'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: closes an unhealthy session and propagates prompt errors', async () => {
  const error = new Error('pi RPC request timed out: prompt')
  const closeCalls: string[] = []
  const session = {
    sessionId: 's1',
    async prompt() {
      throw error
    }
  }
  const sessions = {
    maybeGet() {
      return session
    },
    close(sessionId: string) {
      closeCalls.push(sessionId)
    }
  }
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = sessions

  await assert.rejects(
    () =>
      agent.prompt({
        sessionId: 's1',
        prompt: [{ type: 'text', text: 'hello' }]
      } as any),
    error
  )

  assert.deepEqual(closeCalls, ['s1'])
})

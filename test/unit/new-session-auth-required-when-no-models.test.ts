import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
}

test('PiAcpAgent: newSession throws AUTH_REQUIRED when pi reports zero available models', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      disposeCalled: 0,
      async getAvailableModels() {
        return { models: [] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      },
      dispose() {
        this.disposeCalled += 1
      }
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  let threw = false
  try {
    await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  } catch (e: any) {
    threw = true
    assert.equal(e?.code, -32000)
    assert.match(String(e?.message), /Configure an API key or log in with an OAuth provider/i)
  }

  assert.equal(threw, true)
  assert.equal((session.proc as any).disposeCalled, 1)
})

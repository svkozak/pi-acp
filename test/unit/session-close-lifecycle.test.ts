import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const oldOpenAiKey = process.env.OPENAI_API_KEY

beforeEach(() => {
  process.env.OPENAI_API_KEY = 'test-key'
})

afterEach(() => {
  if (oldOpenAiKey == null) delete process.env.OPENAI_API_KEY
  else process.env.OPENAI_API_KEY = oldOpenAiKey
})

function fakeSession(sessionId: string) {
  return {
    sessionId,
    cwd: process.cwd(),
    setStartupInfo(_text: string) {},
    sendStartupInfoIfPending() {},
    proc: {
      disposeCount: 0,
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
      },
      async getState() {
        return { sessionId, thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
      },
      async getCommands() {
        return { commands: [] }
      },
      dispose() {
        this.disposeCount += 1
      }
    }
  }
}

test('PiAcpAgent: advertises stable session close capability', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.ok(res.agentCapabilities)
  assert.deepEqual((res.agentCapabilities.sessionCapabilities as any).close, {})
})

test('PiAcpAgent: creating a new session does not close other active sessions', async () => {
  const sessions = [fakeSession('s1'), fakeSession('s2')]
  const closeAllExceptCalls: string[] = []

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).sessions = {
    async create() {
      const session = sessions.shift()
      assert.ok(session)
      return session
    },
    closeAllExcept(sessionId: string) {
      closeAllExceptCalls.push(sessionId)
    }
  }

  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

  assert.deepEqual(closeAllExceptCalls, [])
})

test('PiAcpAgent: closeSession disposes only the requested active session', async () => {
  const s1 = fakeSession('s1')
  const s2 = fakeSession('s2')
  const closed: string[] = []

  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()), {} as any)
  ;(agent as any).sessions = {
    close(sessionId: string) {
      closed.push(sessionId)
      if (sessionId === 's1') s1.proc.dispose()
      if (sessionId === 's2') s2.proc.dispose()
    }
  }

  assert.equal(typeof (agent as any).closeSession, 'function')
  await (agent as any).closeSession({ sessionId: 's1' })

  assert.deepEqual(closed, ['s1'])
  assert.equal(s1.proc.disposeCount, 1)
  assert.equal(s2.proc.disposeCount, 0)
})

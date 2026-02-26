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

test('PiAcpAgent: PI_ACP_STARTUP_INFO=false disables startup info generation/emission', async () => {
  const prev = process.env.PI_ACP_STARTUP_INFO
  const prevKey = process.env.OPENAI_API_KEY
  process.env.PI_ACP_STARTUP_INFO = 'false'
  process.env.OPENAI_API_KEY = 'test-key'

  // Spy on setTimeout calls (agent schedules startup info + available commands)
  const realSetTimeout = globalThis.setTimeout
  const timeouts: Array<unknown> = []
  ;(globalThis as any).setTimeout = (fn: unknown, _ms?: number) => {
    timeouts.push(fn)
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()

    let setStartupInfoCalled = false
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return {
            thinkingLevel: 'medium',
            model: { provider: 'test', id: 'model' }
          }
        }
      },
      setStartupInfo(_text: string) {
        setStartupInfoCalled = true
      },
      sendStartupInfoIfPending() {
        throw new Error('should not be scheduled when startup info is disabled')
      }
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)

    assert.equal(res?._meta?.piAcp?.startupInfo, null)
    assert.equal(setStartupInfoCalled, false)

    // Only available_commands_update should be scheduled.
    assert.equal(timeouts.length, 1)
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevKey == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
    if (prev == null) delete process.env.PI_ACP_STARTUP_INFO
    else process.env.PI_ACP_STARTUP_INFO = prev
  }
})

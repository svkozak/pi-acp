import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'

class FakeConn {
  updates: any[] = []
  async sessionUpdate(msg: any) {
    this.updates.push(msg)
  }
}

class FakeSessions {
  constructor(private readonly session: any) {}

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }
}

test('PiAcpAgent: setSessionMode maps to pi setThinkingLevel + emits current_mode_update', async () => {
  const conn = new FakeConn()
  let requestedMode: string | null = null
  const agent = new PiAcpAgent(conn as any)
  ;(agent as any).sessions = new FakeSessions({
    sessionId: 's1',
    proc: {
      async setThinkingLevel(mode: string) {
        requestedMode = mode
      }
    }
  })

  await agent.setSessionMode({ sessionId: 's1', modeId: 'high' } as any)

  assert.equal(requestedMode, 'high')
  assert.ok(
    conn.updates.some(
      update => update.update?.sessionUpdate === 'current_mode_update' && update.update?.modeId === 'high'
    )
  )
})

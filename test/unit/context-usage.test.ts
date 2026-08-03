import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

/** Let the `setTimeout(..., 0)` continuations scheduled after session/new or session/load run. */
async function drainScheduledWork(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

function makeSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpAgent: newSession publishes context usage only after the response is returned', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStats = { contextUsage: { tokens: 1_234, contextWindow: 100_000 } }
  const session = makeSession(proc, conn)

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  assert.equal(result.sessionId, 's1')
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )

  await drainScheduledWork()

  assert.deepEqual(
    conn.updates.filter(u => u.update.sessionUpdate === 'usage_update'),
    [{ sessionId: 's1', update: { sessionUpdate: 'usage_update', used: 1_234, size: 100_000 } }]
  )
})

test('PiAcpAgent: newSession tolerates a failing get_session_stats', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.sessionStatsError = new Error('pi get_session_stats failed: unsupported')
  const session = makeSession(proc, conn)

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  assert.equal(result.sessionId, 's1')

  await drainScheduledWork()

  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )
})

test('PiAcpAgent: switching the model config option refreshes context usage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const state: { thinkingLevel: string; model: { provider: string; id: string } } = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  proc.getAvailableModels = async () => ({
    models: [
      { provider: 'test', id: 'alpha', name: 'Alpha' },
      { provider: 'test', id: 'beta', name: 'Beta' }
    ]
  })
  proc.getState = async () => state
  ;(proc as any).setModel = async (provider: string, modelId: string) => {
    state.model = { provider, id: modelId }
    proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: modelId === 'beta' ? 200_000 : 100_000 } }
  }
  proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: 100_000 } }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: 'test/beta' } as any)

  assert.deepEqual(
    conn.updates.map(u => u.update.sessionUpdate),
    ['config_option_update', 'usage_update']
  )
  assert.deepEqual(conn.updates.at(-1), {
    sessionId: 's1',
    update: { sessionUpdate: 'usage_update', used: 500, size: 200_000 }
  })
})

test('PiAcpAgent: unstable_setSessionModel refreshes context usage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const state: { thinkingLevel: string; model: { provider: string; id: string } } = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  proc.getAvailableModels = async () => ({
    models: [
      { provider: 'test', id: 'alpha', name: 'Alpha' },
      { provider: 'test', id: 'beta', name: 'Beta' }
    ]
  })
  proc.getState = async () => state
  ;(proc as any).setModel = async (provider: string, modelId: string) => {
    state.model = { provider, id: modelId }
    proc.sessionStats = { contextUsage: { tokens: 700, contextWindow: modelId === 'beta' ? 200_000 : 100_000 } }
  }
  proc.sessionStats = { contextUsage: { tokens: 700, contextWindow: 100_000 } }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.unstable_setSessionModel({ sessionId: 's1', modelId: 'test/beta' })

  assert.equal(proc.getSessionStatsCount, 1)
  assert.deepEqual(
    conn.updates.map(u => u.update.sessionUpdate),
    ['config_option_update', 'usage_update']
  )
  assert.deepEqual(conn.updates.at(-1), {
    sessionId: 's1',
    update: { sessionUpdate: 'usage_update', used: 700, size: 200_000 }
  })
})

test('PiAcpAgent: switching the thinking level does not publish context usage', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const state: { thinkingLevel: string; model: { provider: string; id: string } } = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }
  proc.getState = async () => state
  ;(proc as any).setThinkingLevel = async (level: string) => {
    state.thinkingLevel = level
  }
  proc.sessionStats = { contextUsage: { tokens: 500, contextWindow: 100_000 } }

  const session = makeSession(proc, conn)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  await agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'high' } as any)

  assert.equal(proc.getSessionStatsCount, 0)
  assert.equal(
    conn.updates.some(u => u.update.sessionUpdate === 'usage_update'),
    false
  )
})

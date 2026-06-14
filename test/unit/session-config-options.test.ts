import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { FakePiRpcProcess } from '../helpers/fakes.js'

class FakeSessions {
  closeCalls: string[] = []

  constructor(private readonly session: any) {}

  async create(_params: any) {
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }
}

test('PiAcpAgent: newSession returns model config options', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
  assert.ok(Array.isArray(result.configOptions))
  assert.equal(result.configOptions?.[0]?.id, 'model')
  assert.equal(result.configOptions?.[0]?.currentValue, 'test/model')
})

test('PiAcpAgent: setSessionConfigOption maps model changes to pi and emits config update', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    wasCancelRequested() {
      return false
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.setSessionConfigOption({
    sessionId: 's1',
    configId: 'model',
    value: 'test/model'
  } as any)

  assert.deepEqual(proc.setModelCalls, [{ provider: 'test', modelId: 'model' }])
  assert.equal(result.configOptions[0]?.id, 'model')
  assert.ok(conn.updates.some(update => (update as any).update?.sessionUpdate === 'config_option_update'))
})

test('PiAcpAgent: prompt emits usage_update after the turn completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    async prompt() {
      return 'end_turn'
    },
    wasCancelRequested() {
      return false
    }
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions(session) as any

  const result = await agent.prompt({ sessionId: 's1', prompt: [{ type: 'text', text: 'hello' }] } as any)
  assert.equal(result.stopReason, 'end_turn')
  assert.ok(conn.updates.some(update => (update as any).update?.sessionUpdate === 'usage_update'))
})

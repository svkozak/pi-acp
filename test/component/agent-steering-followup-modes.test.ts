import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /steering reports current steeringMode', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'all' })

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  const last = conn.updates.at(-1)
  assert.equal(last?.update?.sessionUpdate, 'agent_message_chunk')
  assert.match((last as any).update.content.text, /Steering mode: all/)
})

test('PiAcpAgent: /steering sets steering mode', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  let setTo: string | null = null
  proc.getState = async () => ({ steeringMode: 'all' })
  proc.setSteeringMode = async (m: string) => {
    setTo = m
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering one-at-a-time' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(setTo, 'one-at-a-time')
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode set to: one-at-a-time/)
})

test('PiAcpAgent: /steering rejects invalid value', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  let called = false
  proc.getState = async () => ({ steeringMode: 'all' })
  proc.setSteeringMode = async () => {
    called = true
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering nope' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(called, false)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Usage: \/steering/)
})

test('PiAcpAgent: /follow-up reports current followUpMode', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ followUpMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/follow-up' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Follow-up mode: one-at-a-time/)
})

test('PiAcpAgent: /follow-up sets follow-up mode', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  let setTo: string | null = null
  proc.getState = async () => ({ followUpMode: 'one-at-a-time' })
  proc.setFollowUpMode = async (m: string) => {
    setTo = m
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/follow-up all' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(setTo, 'all')
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Follow-up mode set to: all/)
})

test('PiAcpAgent: /follow-up rejects invalid value', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  let called = false
  proc.getState = async () => ({ followUpMode: 'one-at-a-time' })
  proc.setFollowUpMode = async () => {
    called = true
  }

  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/follow-up ???' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(called, false)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Usage: \/follow-up/)
})

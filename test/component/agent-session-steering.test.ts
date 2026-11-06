import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function setup() {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc,
    conn: asAgentConn(conn),
    fileCommands: [],
    autoTitle: false
  })
  proc.getState = async () => ({})
  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = { maybeGet: () => session, get: () => session }
  return { agent, session, proc }
}

const steerParams = (extra: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  prompt: [{ type: 'text', text: 'do this instead' }],
  ...extra
})

test('PiAcpAgent: advertises steering support on initialize', async () => {
  const { agent } = setup()
  const res: any = await agent.initialize({ protocolVersion: 1 } as any)
  assert.equal(res._meta?.steering?.supported, true)
})

test('PiAcpAgent: _session/steering injects into a running turn', async () => {
  const { agent, session, proc } = setup()
  const turn = session.prompt('first')
  proc.emit({ type: 'agent_start' })

  const res = await agent.extMethod!('_session/steering', steerParams())

  assert.deepEqual(res, { outcome: 'injected' })
  assert.deepEqual(proc.steers, [{ message: 'do this instead', images: [] }])

  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await turn
})

test('PiAcpAgent: _session/steering reports failed when pi rejects the steer', async () => {
  const { agent, session, proc } = setup()
  const turn = session.prompt('first')
  proc.steerError = new Error('nope')

  const res = await agent.extMethod!('_session/steering', steerParams())

  assert.deepEqual(res, { outcome: 'failed' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  await turn
})

test('PiAcpAgent: _session/steering honors promptRequired when idle', async () => {
  const { agent, proc } = setup()

  const res = await agent.extMethod!(
    '_session/steering',
    steerParams({ _meta: { steering: { idleBehavior: 'promptRequired' } } })
  )

  assert.deepEqual(res, { outcome: 'promptRequired', reason: 'noRunningTurn' })
  assert.equal(proc.steers.length, 0)
  assert.equal(proc.prompts.length, 0)
})

test('PiAcpAgent: _session/steering starts a new turn when idle', async () => {
  const { agent, proc } = setup()

  const res = await agent.extMethod!('_session/steering', steerParams())

  assert.deepEqual(res, { outcome: 'startedNewTurn', detached: true })
  assert.equal(proc.steers.length, 0)
  assert.equal(proc.prompts[0]?.message, 'do this instead')
})

test('PiAcpAgent: unknown extension methods are rejected', async () => {
  const { agent } = setup()
  await assert.rejects(() => agent.extMethod!('_nope', {}))
})

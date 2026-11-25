import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../src/acp/agent.js'
import { PiAcpSession } from '../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from './helpers/fakes.js'

/**
 * Contract for the `_session/steering` ACP extension method (same method name
 * as @agentclientprotocol/claude-agent-acp). NOTE: this is unrelated to pi's
 * `/steering` slash command, which toggles queue delivery mode.
 */
function makeAgentWithSession(sessionId = 's-steer') {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId,
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const agent = new PiAcpAgent(asAgentConn(conn))
  // Inject the session so restoreSession() finds it without spawning pi.
  ;(agent as any).sessions = {
    maybeGet: (id: string) => (id === sessionId ? session : null)
  }

  return { agent, proc, session }
}

test('initialize: advertises _meta.steering.supported = true', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.equal((res as any)._meta?.steering?.supported, true)
})

test('_session/steering: outcome injected when a turn is running', async () => {
  const { agent, proc, session } = makeAgentWithSession()

  // Start a turn; the fake proc never emits agent_settled, so it stays pending.
  void session.prompt('first turn')
  await new Promise(r => setTimeout(r, 0))

  const res = await agent.extMethod('_session/steering', {
    sessionId: 's-steer',
    prompt: [{ type: 'text', text: 'vira a plan b' }]
  })

  assert.deepEqual(res, { outcome: 'injected' })
  assert.equal(proc.steers.length, 1)
  assert.equal(proc.steers[0]!.message, 'vira a plan b')
  assert.deepEqual(proc.steers[0]!.images, [])
})

test('_session/steering: outcome injected passes images through untouched', async () => {
  const { agent, proc, session } = makeAgentWithSession()

  void session.prompt('turn with images')
  await new Promise(r => setTimeout(r, 0))

  const images = [{ type: 'image', mimeType: 'image/png', data: 'aGk=' }]
  await agent.extMethod('_session/steering', {
    sessionId: 's-steer',
    prompt: [{ type: 'text', text: 'mirá esto' }, ...images]
  })

  assert.equal(proc.steers.length, 1)
  assert.equal(proc.steers[0]!.message, 'mirá esto')
  assert.deepEqual(proc.steers[0]!.images, images)
})

test('_session/steering: outcome promptRequired when idle and client opted in', async () => {
  const { agent, proc } = makeAgentWithSession()

  const res = await agent.extMethod('_session/steering', {
    sessionId: 's-steer',
    prompt: [{ type: 'text', text: 'no hay turno' }],
    _meta: { steering: { idleBehavior: 'promptRequired' } }
  })

  assert.deepEqual(res, { outcome: 'promptRequired', reason: 'noRunningTurn' })
  assert.equal(proc.steers.length, 0)
  assert.equal(proc.prompts.length, 0) // no turn started
})

test('_session/steering: outcome startedNewTurn starts a detached prompt when idle', async () => {
  const { agent, proc } = makeAgentWithSession()

  const res = await agent.extMethod('_session/steering', {
    sessionId: 's-steer',
    prompt: [{ type: 'text', text: 'empezá de una' }]
  })

  // Response must not wait for the turn to finish.
  assert.deepEqual(res, { outcome: 'startedNewTurn' })

  // Fire-and-forget: give the detached prompt a tick to reach the fake proc.
  await new Promise(r => setTimeout(r, 0))
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0]!.message, 'empezá de una')
})

test('_session/steering: unknown session returns an ACP error', async () => {
  const { agent } = makeAgentWithSession()

  await assert.rejects(
    () => agent.extMethod('_session/steering', { sessionId: 'nope', prompt: [] }),
    (e: any) => e?.code === -32602 // invalidParams, same as session/prompt on unknown ids
  )
})

test('extMethod: unknown method returns methodNotFound', async () => {
  const { agent } = makeAgentWithSession()

  await assert.rejects(
    () => agent.extMethod('_session/other', {}),
    (e: any) => e?.code === -32601
  )
})

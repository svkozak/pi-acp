import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(proc: FakePiRpcProcess, conn: FakeAgentSideConnection) {
  return new PiAcpSession({
    sessionId: 'test-session',
    cwd: '/tmp/test',
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('session.prompt() steers when a turn is already running', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)

  // Start a turn (won't resolve until agent_end)
  const firstPromise = session.prompt('first message')

  // Second message while turn is running — should steer
  const secondResult = await session.prompt('adjust your approach')

  assert.equal(secondResult, 'end_turn')
  assert.equal(proc.steers.length, 1)
  assert.equal(proc.steers[0], 'adjust your approach')

  // Should NOT have been sent as a second prompt
  assert.equal(proc.prompts.length, 1)
  assert.equal(proc.prompts[0].message, 'first message')

  // Verify steering confirmation was emitted
  const steerUpdate = conn.updates.find(u => (u as any).update?.content?.text?.includes('Steering message delivered'))
  assert.ok(steerUpdate, 'should emit steering confirmation')

  // Complete the first turn
  proc.emit({ type: 'agent_end' })
  const firstResult = await firstPromise
  assert.equal(firstResult, 'end_turn')
})

test('session.prompt() falls back to queue when steer fails', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.steerShouldFail = true
  const session = createSession(proc, conn)

  // Start a turn
  const firstPromise = session.prompt('first message')

  // Second message — steer will fail, should fall back to queue
  const secondPromise = session.prompt('queued message')

  // Verify it was queued, not steered
  assert.equal(proc.steers.length, 0)

  // Complete first turn — queued message should start processing
  proc.emit({ type: 'agent_end' })
  await firstPromise

  // Allow microtasks to settle (queue processing is async)
  await new Promise(r => setTimeout(r, 10))

  // The queued message should now be a prompt
  assert.equal(proc.prompts.length, 2)
  assert.equal(proc.prompts[1].message, 'queued message')

  // Complete the queued turn
  proc.emit({ type: 'agent_end' })
  const secondResult = await secondPromise
  assert.equal(secondResult, 'end_turn')
})

test('multiple steers during a single turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = createSession(proc, conn)

  // Start a turn
  const firstPromise = session.prompt('do the thing')

  // Send multiple steers
  await session.prompt('actually use typescript')
  await session.prompt('and add tests')
  await session.prompt('focus on src/main.ts')

  assert.equal(proc.steers.length, 3)
  assert.deepEqual(proc.steers, ['actually use typescript', 'and add tests', 'focus on src/main.ts'])

  // Still only one prompt was sent
  assert.equal(proc.prompts.length, 1)

  proc.emit({ type: 'agent_end' })
  await firstPromise
})

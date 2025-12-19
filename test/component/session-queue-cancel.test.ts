import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: cancel clears queued prompts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  const first = session.prompt('one')
  const second = session.prompt('two')
  const third = session.prompt('three')

  // first started, second+third queued
  assert.equal(proc.prompts.length, 1)

  await session.cancel()

  assert.equal(proc.abortCount, 1)

  // queued prompts should resolve as cancelled
  assert.equal(await second, 'cancelled')
  assert.equal(await third, 'cancelled')

  // finish first prompt as cancelled (agent_end after abort)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  assert.equal(await first, 'cancelled')

  // queue should have been cleared, so no further prompt started
  assert.equal(proc.prompts.length, 1)
})

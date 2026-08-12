import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession() {
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
  return { conn, proc, session }
}

function chunkTexts(conn: FakeAgentSideConnection): string[] {
  return conn.updates
    .filter(u => u.update.sessionUpdate === 'agent_message_chunk')
    .map(u => (u.update as any).content.text as string)
}

test('PiAcpSession: surfaces provider error at agent_settled when final assistant message errored', async () => {
  const { conn, proc, session } = makeSession()

  const turn = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  proc.emit({ type: 'agent_start' } as any)
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '400 invalid_request_error: quota' }
  } as any)
  proc.emit({ type: 'agent_end' } as any)
  proc.emit({ type: 'agent_settled' } as any)

  const reason = await turn
  assert.equal(reason, 'end_turn')
  assert.ok(
    chunkTexts(conn).some(t => t.includes('Provider error: 400 invalid_request_error: quota')),
    `expected provider error chunk, got: ${JSON.stringify(chunkTexts(conn))}`
  )
})

test('PiAcpSession: does not report an error the run recovered from', async () => {
  const { conn, proc, session } = makeSession()

  const turn = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  proc.emit({ type: 'agent_start' } as any)
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded' }
  } as any)
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000 } as any)
  proc.emit({ type: 'auto_retry_end', success: true, attempt: 2 } as any)
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }
  } as any)
  proc.emit({ type: 'agent_settled' } as any)

  await turn
  const texts = chunkTexts(conn)
  assert.ok(!texts.some(t => t.includes('529 overloaded')), `transient error leaked: ${JSON.stringify(texts)}`)
  assert.ok(texts.some(t => t === 'Retry finished, resuming.'))
})

test('PiAcpSession: reports retry exhaustion with finalError instead of "resuming"', async () => {
  const { conn, proc, session } = makeSession()

  const turn = session.prompt('hello')
  await new Promise(r => setTimeout(r, 0))

  proc.emit({ type: 'agent_start' } as any)
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '529 overloaded' }
  } as any)
  proc.emit({
    type: 'auto_retry_end',
    success: false,
    attempt: 3,
    finalError: '529 overloaded_error: Overloaded'
  } as any)
  proc.emit({ type: 'agent_settled' } as any)

  await turn
  const texts = chunkTexts(conn)
  assert.ok(
    texts.some(t => t === 'Retry failed after 3 attempts: 529 overloaded_error: Overloaded'),
    `expected retry-failed chunk, got: ${JSON.stringify(texts)}`
  )
  assert.ok(!texts.some(t => t === 'Retry finished, resuming.'))
  // Already reported at auto_retry_end; must not repeat at agent_settled.
  assert.equal(texts.filter(t => t.includes('529 overloaded')).length, 1)
})

test('PiAcpSession: non-auth prompt rejection reaches the client as text', async () => {
  const { conn, proc, session } = makeSession()

  proc.nextPromptError = new Error(
    "pi prompt failed: Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message."
  )

  const reason = await session.prompt('hello')
  assert.equal(reason, 'error')
  assert.ok(
    chunkTexts(conn).some(t => t.startsWith('Prompt failed: ') && t.includes('Agent is already processing')),
    `expected prompt-failure chunk, got: ${JSON.stringify(chunkTexts(conn))}`
  )
})

test('PiAcpSession: fresh turn does not inherit a stale error from a previous turn', async () => {
  const { conn, proc, session } = makeSession()

  const turn1 = session.prompt('first')
  await new Promise(r => setTimeout(r, 0))
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'boom' }
  } as any)
  proc.emit({ type: 'agent_settled' } as any)
  await turn1

  const turn2 = session.prompt('second')
  await new Promise(r => setTimeout(r, 0))
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stopReason: 'stop' }
  } as any)
  proc.emit({ type: 'agent_settled' } as any)
  await turn2

  const texts = chunkTexts(conn)
  assert.equal(texts.filter(t => t.includes('boom')).length, 1)
})

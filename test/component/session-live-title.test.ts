import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(title?: string) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    title
  })
  return { conn, proc, session }
}

function titles(conn: FakeAgentSideConnection): string[] {
  return conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'session_info_update' && typeof update.title === 'string' ? [update.title] : []
  )
}

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('PiAcpSession: publishes the first user message title even after the startup banner', async () => {
  const { conn, proc, session } = createSession()
  session.setStartupInfo('Pi startup banner')
  session.sendStartupInfoIfPending()
  const turn = session.prompt('Fix thread titles')
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'Fix thread titles' } })
  await flush()

  assert.deepEqual(titles(conn), ['Fix thread titles'])
  assert.equal(conn.updates[0]?.update.sessionUpdate, 'agent_message_chunk')

  proc.emit({ type: 'message_end', message: { role: 'user', content: 'Fix thread titles' } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(titles(conn), ['Fix thread titles'])
})

test('PiAcpSession: does not replace the first title on later or queued prompts', async () => {
  const { conn, proc, session } = createSession()
  const first = session.prompt('First task')
  const second = session.prompt('Second task')
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'First task' } })
  proc.emit({ type: 'agent_settled' })
  await first
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'Second task' } })
  proc.emit({ type: 'agent_settled' })
  await second
  assert.deepEqual(titles(conn), ['First task'])
})

test('PiAcpSession: preserves an existing title instead of using a resumed prompt', async () => {
  const { conn, proc } = createSession('Existing name')
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'Continue working' } })
  await flush()
  assert.deepEqual(titles(conn), ['Existing name'])
})

test('PiAcpSession: skips non-user and textless messages and accepts the first later text', async () => {
  const { conn, proc } = createSession()
  proc.emit({ type: 'message_start', message: { role: 'assistant', content: 'Startup information' } })
  proc.emit({ type: 'message_start', message: { role: 'toolResult', content: 'Tool output' } })
  proc.emit({ type: 'message_start', message: { role: 'user', content: [{ type: 'image', data: 'AAAA' }] } })
  proc.emit({ type: 'message_start', message: { role: 'user', content: ' \n\t ' } })
  await flush()
  assert.deepEqual(titles(conn), [])

  proc.emit({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: '  Explain\n this screenshot  ' }] }
  })
  await flush()
  assert.deepEqual(titles(conn), ['Explain this screenshot'])
})

test('PiAcpSession: bounds fallback titles without splitting Unicode characters', async () => {
  const { conn, proc } = createSession()
  proc.emit({ type: 'message_start', message: { role: 'user', content: `${'中'.repeat(79)}😀 end` } })
  await flush()
  assert.deepEqual(titles(conn), [`${'中'.repeat(79)}😀`])
})

test('PiAcpSession: rejected prompts do not get a fallback title', async () => {
  const { conn, proc, session } = createSession()
  proc.prompt = async () => {
    throw new Error('Prompt rejected')
  }
  assert.equal(await session.prompt('Not accepted'), 'error')
  assert.deepEqual(titles(conn), [])
})

test('PiAcpSession: title notification failures do not prevent prompt completion', async () => {
  const { conn, proc, session } = createSession()
  conn.sessionUpdate = async () => {
    throw new Error('Client disconnected')
  }
  const turn = session.prompt('First task')
  proc.emit({ type: 'message_start', message: { role: 'user', content: 'First task' } })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await turn, 'end_turn')
})

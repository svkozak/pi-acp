import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(
  conn: FakeAgentSideConnection,
  proc: FakePiRpcProcess,
  options: { autoTitle?: boolean } = { autoTitle: true }
): PiAcpSession {
  return new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    autoTitle: options.autoTitle
  })
}

async function settlePrompt(proc: FakePiRpcProcess, prompt: Promise<string>): Promise<string> {
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
  return prompt
}

test('PiAcpSession: names a new session when its first prompt starts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const assignedNames: string[] = []
  proc.getState = async () => ({})
  proc.setSessionName = async (name: string) => {
    assignedNames.push(name)
  }
  const session = createSession(conn, proc)

  const prompt = session.prompt('hello', [], 'Fix thread titles')
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(assignedNames, ['Fix thread titles'])
  const titleUpdates = conn.updates.filter(update => (update.update as any).title !== undefined)
  assert.equal(titleUpdates.length, 1)
  assert.equal((titleUpdates[0]!.update as any).title, 'Fix thread titles')
  assert.equal(typeof (titleUpdates[0]!.update as any).updatedAt, 'string')

  assert.equal(await settlePrompt(proc, prompt), 'end_turn')
  await settlePrompt(proc, session.prompt('second prompt', [], 'Second title'))
  assert.deepEqual(assignedNames, ['Fix thread titles'])
})

test('PiAcpSession: preserves an existing session name', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  let setNameCalls = 0
  proc.getState = async () => ({ sessionName: 'Manual title' })
  proc.setSessionName = async () => {
    setNameCalls += 1
  }
  const session = createSession(conn, proc)

  const reason = await settlePrompt(proc, session.prompt('hello', [], 'Automatic title'))

  assert.equal(reason, 'end_turn')
  assert.equal(setNameCalls, 0)
  const titleUpdates = conn.updates.filter(update => (update.update as any).title !== undefined)
  assert.equal((titleUpdates.at(-1)!.update as any).title, 'Manual title')
})

test('PiAcpSession: does not overwrite a manual name assigned during the first prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  const assignedNames: string[] = []
  proc.getState = async () => ({})
  proc.setSessionName = async (name: string) => {
    assignedNames.push(name)
  }
  const session = createSession(conn, proc)

  const prompt = session.prompt('hello', [], 'Automatic title')
  await session.setSessionName('Manual title')
  const reason = await settlePrompt(proc, prompt)

  assert.equal(reason, 'end_turn')
  assert.deepEqual(assignedNames, ['Automatic title', 'Manual title'])
  const titleUpdates = conn.updates.filter(update => (update.update as any).title !== undefined)
  assert.equal((titleUpdates.at(-1)!.update as any).title, 'Manual title')
})

test('PiAcpSession: auto-title failures do not fail the prompt', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({})
  proc.setSessionName = async () => {
    throw new Error('set_session_name failed')
  }
  const session = createSession(conn, proc)

  const reason = await settlePrompt(proc, session.prompt('hello', [], 'Automatic title'))

  assert.equal(reason, 'end_turn')
  const titleUpdates = conn.updates.filter(update => (update.update as any).title !== undefined)
  assert.equal(titleUpdates.length, 0)
})

test('PiAcpSession: forwards Pi session name changes to ACP', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  createSession(conn, proc, { autoTitle: false })

  proc.emit({ type: 'session_info_changed', name: 'Extension title' })
  await new Promise(resolve => setTimeout(resolve, 0))

  const titleUpdate = conn.updates.find(update => (update.update as any).title !== undefined)
  assert.equal((titleUpdate!.update as any).title, 'Extension title')
})

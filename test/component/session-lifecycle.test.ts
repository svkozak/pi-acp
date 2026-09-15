import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function setup(t: TestContext) {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-'))
  const previousPath = process.env.PATH
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  // No installed Pi, npm update checks, or user resources are needed by these fakes.
  process.env.PATH = cwd
  process.env.PI_CODING_AGENT_DIR = cwd
  const store = new SessionStore(join(cwd, 'session-map.json'))
  const sessions = new SessionManager()
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn))
  Object.assign(sessions, { store })
  Object.assign(agent, { store, sessions })
  const procs: FakePiRpcProcess[] = []
  t.mock.method(PiRpcProcess, 'spawn', async (params: { sessionPath?: string }) => {
    const proc = new FakePiRpcProcess()
    const sessionId = `s${procs.length + 1}`
    const sessionFile = params.sessionPath ?? join(cwd, `${sessionId}.jsonl`)
    if (!params.sessionPath) {
      writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: sessionId, cwd }) + '\n')
    }
    proc.getState = async () => ({
      sessionId,
      sessionFile,
      model: { provider: 'test', id: 'model' },
      thinkingLevel: 'medium'
    })
    procs.push(proc)
    return proc as unknown as PiRpcProcess
  })
  t.after(async () => {
    agent.dispose()
    await tick()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    rmSync(cwd, { recursive: true, force: true })
  })
  return { cwd, store, sessions, conn, agent, procs }
}

for (const action of ['new', 'load'] as const) {
  test(`session/${action} preserves another session's accepted prompt`, async t => {
    const { cwd, agent, procs, sessions, store } = setup(t)
    const first = await agent.newSession({ cwd, mcpServers: [] })
    const running = sessions.get(first.sessionId).prompt('first task')
    await tick() // Pi has acknowledged acceptance, but has not emitted agent_settled.
    if (action === 'new') {
      await agent.newSession({ cwd, mcpServers: [] })
    } else {
      store.upsert({ sessionId: 'saved', cwd, sessionFile: join(cwd, 'saved.jsonl') })
      await agent.loadSession({ sessionId: 'saved', cwd, mcpServers: [] })
    }
    assert.equal(procs[0]!.disposeCount, 0)
    assert.ok(sessions.maybeGet(first.sessionId))
    const secondId = action === 'new' ? 's2' : 'saved'
    const second = sessions.get(secondId).prompt('second task')
    procs[1]!.emit({ type: 'agent_settled' })
    assert.equal(await second, 'end_turn')
    procs[0]!.emit({ type: 'agent_settled' })
    assert.equal(await running, 'end_turn')
  })
}

test('reloading a running session reuses its process without cancelling its turn', async t => {
  const { cwd, agent, procs, sessions } = setup(t)
  const first = await agent.newSession({ cwd, mcpServers: [] })
  const session = sessions.get(first.sessionId)
  const running = session.prompt('keep working')
  await tick()
  await agent.loadSession({ sessionId: first.sessionId, cwd, mcpServers: [] })
  assert.equal(procs.length, 1)
  assert.equal(procs[0]!.disposeCount, 0)
  assert.equal(sessions.get(first.sessionId), session)
  procs[0]!.emit({ type: 'agent_settled' })
  assert.equal(await running, 'end_turn')
})

test('closing a session settles accepted and queued prompts without agent_settled', { timeout: 2000 }, async t => {
  const { cwd, agent, procs, sessions, conn } = setup(t)
  const first = await agent.newSession({ cwd, mcpServers: [] })
  const session = sessions.get(first.sessionId)
  const turns = [session.prompt('one'), session.prompt('two'), session.prompt('three')]
  await tick()
  sessions.close(first.sessionId)
  assert.deepEqual(await Promise.all(turns), ['cancelled', 'cancelled', 'cancelled'])
  assert.equal(procs[0]!.prompts.length, 1)
  assert.equal(procs[0]!.disposeCount, 1)
  assert.equal(sessions.maybeGet(first.sessionId), undefined)
  assert.ok(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'session_info_update' &&
        JSON.stringify(update._meta) === JSON.stringify({ piAcp: { queueDepth: 0, running: false } })
    )
  )
})

test(
  'process exit settles accepted/queued prompts, fails tools, and permits a later restore',
  { timeout: 2000 },
  async t => {
    const { cwd, agent, procs, sessions, conn } = setup(t)
    const first = await agent.newSession({ cwd, mcpServers: [] })
    const session = sessions.get(first.sessionId)
    const turns = [session.prompt('one'), session.prompt('two')]
    await tick()
    procs[0]!.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: {} })
    procs[0]!.emit({ type: 'process_exit', error: 'pi process exited (code=1, signal=null)' })
    assert.deepEqual(await Promise.all(turns), ['error', 'error'])
    assert.equal(procs[0]!.prompts.length, 1)
    assert.ok(
      conn.updates.some(
        ({ update }) =>
          update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'tool-1' && update.status === 'failed'
      )
    )
    assert.ok(
      conn.updates.some(
        ({ update }) =>
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          /process exited/.test(update.content.text)
      )
    )
    await agent.loadSession({ sessionId: first.sessionId, cwd, mcpServers: [] })
    assert.equal(procs.length, 2)
    assert.notEqual(sessions.get(first.sessionId), session)
  }
)

test('late settlement cannot restart queued work after disposal', { timeout: 2000 }, async t => {
  const { cwd, agent, procs, sessions } = setup(t)
  const first = await agent.newSession({ cwd, mcpServers: [] })
  const session = sessions.get(first.sessionId)
  const turns = [session.prompt('one'), session.prompt('two')]
  procs[0]!.emit({ type: 'agent_settled' })
  sessions.close(first.sessionId)
  procs[0]!.emit({ type: 'agent_settled' })
  assert.deepEqual(await Promise.all(turns), ['cancelled', 'cancelled'])
  assert.equal(procs[0]!.prompts.length, 1)
})

test('disposing the agent closes every concurrent session and settles their turns', { timeout: 2000 }, async t => {
  const { cwd, agent, procs, sessions } = setup(t)
  const first = await agent.newSession({ cwd, mcpServers: [] })
  const second = await agent.newSession({ cwd, mcpServers: [] })
  const turns = [sessions.get(first.sessionId).prompt('one'), sessions.get(second.sessionId).prompt('two')]
  await tick()
  agent.dispose()
  agent.dispose()
  assert.deepEqual(await Promise.all(turns), ['cancelled', 'cancelled'])
  assert.deepEqual(
    procs.map(proc => proc.disposeCount),
    [1, 1]
  )
})

test('deleting an active session closes only its own process', { timeout: 2000 }, async t => {
  const { cwd, agent, procs, sessions, store } = setup(t)
  const first = await agent.newSession({ cwd, mcpServers: [] })
  const second = await agent.newSession({ cwd, mcpServers: [] })
  const running = sessions.get(first.sessionId).prompt('one')
  await agent.deleteSession({ sessionId: first.sessionId })
  assert.equal(await running, 'cancelled')
  assert.deepEqual(
    procs.map(proc => proc.disposeCount),
    [1, 0]
  )
  assert.equal(store.get(first.sessionId), null)
  assert.ok(sessions.maybeGet(second.sessionId))
})

test('the next prompt restores an idle session whose process exited', { timeout: 2000 }, async t => {
  const { cwd, agent, procs } = setup(t)
  const first = await agent.newSession({ cwd, mcpServers: [] })
  procs[0]!.emit({ type: 'process_exit', error: 'pi process exited (code=1, signal=null)' })
  const turn = agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'resume' }] })
  await tick()
  assert.equal(procs.length, 2)
  assert.equal(procs[1]!.prompts[0]!.message, 'resume')
  procs[1]!.emit({ type: 'agent_settled' })
  assert.equal((await turn).stopReason, 'end_turn')
})

test('process exit after a cancellation preserves the cancelled result', async () => {
  const proc = new FakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: '/tmp',
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  const turn = session.prompt('one')
  await session.cancel()
  proc.emit({ type: 'process_exit', error: 'pi process exited (code=null, signal=SIGTERM)' })
  assert.equal(await turn, 'cancelled')
  session.dispose()
  session.dispose()
  assert.equal(proc.disposeCount, 1)
  await assert.rejects(session.prompt('too late'), /session is closed/)
})

test('an old prompt rejection cannot settle a newer turn', async () => {
  const proc = new FakePiRpcProcess()
  const conn = new FakeAgentSideConnection()
  let rejectFirst!: (error: Error) => void
  proc.prompt = () =>
    new Promise<void>((_, reject) => {
      rejectFirst = reject
    })
  const session = new PiAcpSession({
    sessionId: 's',
    cwd: '/tmp',
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  const first = session.prompt('one')
  const rejectOld = rejectFirst
  const second = session.prompt('two')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'end_turn')
  let settled = false
  void second.then(() => {
    settled = true
  })
  rejectOld(new Error('late RPC failure'))
  await tick()
  assert.equal(settled, false)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})

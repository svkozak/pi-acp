import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(opts: { titleProc?: FakePiRpcProcess; autoTitleEnabled?: boolean; hasExistingTitle?: boolean; titleTimeoutMs?: number } = {}) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const titleProc = opts.titleProc ?? new FakePiRpcProcess()

  titleProc.messages = {
    messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Fix Login Redirect Loop' }] }]
  }

  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    autoTitleEnabled: opts.autoTitleEnabled,
    hasExistingTitle: opts.hasExistingTitle,
    titleTimeoutMs: opts.titleTimeoutMs,
    titleProcessFactory: async () => titleProc as any
  })

  return { conn, proc, session, titleProc }
}

async function flushAutoTitle(titleProc: FakePiRpcProcess) {
  await new Promise(r => setTimeout(r, 0))
  titleProc.emit({ type: 'agent_end' })
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))
}

test('PiAcpSession: auto-generates title from first regular prompt', async () => {
  const { conn, proc, session, titleProc } = makeSession()

  void session.prompt('Fix the login redirect loop')
  await flushAutoTitle(titleProc)

  assert.equal(titleProc.prompts.length, 1)
  assert.match(titleProc.prompts[0]!.message, /Generate a concise title/)
  assert.deepEqual(proc.setSessionNameCalls, ['Fix Login Redirect Loop'])
  assert.equal(
    conn.updates.some(update => (update.update as any).title === 'Fix Login Redirect Loop'),
    true
  )
})

test('PiAcpSession: does not auto-title slash commands', async () => {
  const { session, titleProc, proc } = makeSession()

  void session.prompt('/session')
  await flushAutoTitle(titleProc)

  assert.equal(titleProc.prompts.length, 0)
  assert.deepEqual(proc.setSessionNameCalls, [])
})

test('PiAcpSession: starts auto-title only once', async () => {
  const { session, titleProc } = makeSession()

  void session.prompt('Fix the login redirect loop')
  void session.prompt('And update the tests')
  await flushAutoTitle(titleProc)

  assert.equal(titleProc.prompts.length, 1)
})

test('PiAcpSession: manual title prevents auto-title overwrite', async () => {
  const { session, titleProc, proc } = makeSession()

  void session.prompt('Fix the login redirect loop')
  await session.setManualTitle('Custom Thread Name')
  await flushAutoTitle(titleProc)

  assert.deepEqual(proc.setSessionNameCalls, ['Custom Thread Name'])
})

test('PiAcpSession: falls back to prompt-derived title when worker fails', async () => {
  const { session, proc } = makeSession({
    titleProc: {
      prompt: async () => {
        throw new Error('boom')
      },
      dispose: () => {},
      onEvent: () => () => {}
    } as any
  })

  void session.prompt('Please fix the login redirect loop in auth before release')
  await new Promise(r => setTimeout(r, 0))
  await new Promise(r => setTimeout(r, 0))

  assert.deepEqual(proc.setSessionNameCalls, ['Please fix the login redirect loop in auth'])
})

test('PiAcpSession: existing session title disables auto-title', async () => {
  const { session, titleProc, proc } = makeSession({ hasExistingTitle: true })

  void session.prompt('Fix the login redirect loop')
  await flushAutoTitle(titleProc)

  assert.equal(titleProc.prompts.length, 0)
  assert.deepEqual(proc.setSessionNameCalls, [])
})

test('PiAcpSession: disposes stuck title worker after timeout', async () => {
  const { session, titleProc, proc } = makeSession({ titleTimeoutMs: 1 })

  void session.prompt('Fix the login redirect loop')
  await new Promise(r => setTimeout(r, 10))

  assert.equal(titleProc.disposeCount, 1)
  assert.deepEqual(proc.setSessionNameCalls, ['Fix the login redirect loop'])
})

test('PiAcpSession: dispose stops active title worker and prevents late title updates', async () => {
  const { session, titleProc, proc } = makeSession()

  void session.prompt('Fix the login redirect loop')
  await new Promise(r => setTimeout(r, 0))
  session.dispose()
  await flushAutoTitle(titleProc)

  assert.equal(titleProc.disposeCount, 1)
  assert.deepEqual(proc.setSessionNameCalls, [])
})

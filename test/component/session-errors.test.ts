import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

function setup(conn = new FakeAgentSideConnection(), proc = new FakePiRpcProcess()) {
  const session = new PiAcpSession({
    sessionId: 'errors',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { session, proc, conn }
}

function assistant(proc: FakePiRpcProcess, stopReason: string, errorMessage?: string) {
  proc.emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason, errorMessage } })
}

function texts(conn: FakeAgentSideConnection) {
  return conn.updates.flatMap(({ update }) =>
    update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
  )
}

for (const reason of [
  '429: Monthly usage limit reached',
  '503: Service unavailable',
  'Connection reset by peer',
  '',
  undefined
]) {
  test(`final assistant failure reaches the caller: ${reason ?? 'missing reason'}`, async () => {
    const { session, proc, conn } = setup()
    const failed = assert.rejects(session.prompt('one'), reason ? new RegExp(reason) : /could not complete/)
    assistant(proc, 'error', reason)
    proc.emit({ type: 'agent_settled' })
    await failed
    assert.deepEqual(texts(conn), [])
  })
}

test('final failure stays rejected after context usage is published', async () => {
  const { session, proc, conn } = setup()
  proc.sessionStats = { contextUsage: { tokens: 42, contextWindow: 100 } }
  const failed = assert.rejects(session.prompt('one'), /Provider unavailable/)
  assistant(proc, 'error', 'Provider unavailable')
  proc.emit({ type: 'agent_settled' })
  await failed
  assert.deepEqual(
    conn.updates.filter(({ update }) => update.sessionUpdate === 'usage_update'),
    [{ sessionId: 'errors', update: { sessionUpdate: 'usage_update', used: 42, size: 100 } }]
  )
})

test('recovered retry waits for settlement and clears the provisional failure', async () => {
  const { session, proc } = setup()
  let done = false
  const prompt = session.prompt('one').finally(() => {
    done = true
  })
  assistant(proc, 'error', '503 unavailable')
  proc.emit({ type: 'agent_end', willRetry: true })
  proc.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 2, delayMs: 1 })
  await tick()
  assert.equal(done, false)
  assistant(proc, 'stop')
  proc.emit({ type: 'auto_retry_end', success: true })
  await tick()
  assert.equal(done, false)
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('retry exhaustion reports finalError without claiming to resume', async () => {
  const { session, proc, conn } = setup()
  const failed = assert.rejects(session.prompt('one'), /Provider unavailable/)
  proc.emit({ type: 'auto_retry_end', success: false, finalError: 'Provider unavailable', attempt: 3 })
  proc.emit({ type: 'agent_settled' })
  await failed
  assert.deepEqual(texts(conn), [])
})

test('retry exhaustion without finalError retains the last provider explanation', async () => {
  const { session, proc } = setup()
  const failed = assert.rejects(session.prompt('one'), /503: Service unavailable/)
  assistant(proc, 'error', '503: Service unavailable')
  proc.emit({ type: 'auto_retry_end', success: false })
  proc.emit({ type: 'agent_settled' })
  await failed
})

for (const eventType of ['compaction_end', 'auto_compaction_end']) {
  test(`${eventType} failure is visible and never reported as successful`, async () => {
    const { session, proc, conn } = setup()
    const failed = assert.rejects(session.prompt('one'), /Summary failed/)
    proc.emit({ type: eventType, result: null, aborted: false, errorMessage: 'Summary failed' })
    proc.emit({ type: 'agent_settled' })
    await failed
    assert.deepEqual(texts(conn), [])
  })
}

test('compaction followed by successful assistant recovery clears the earlier model error', async () => {
  const { session, proc } = setup()
  const prompt = session.prompt('one')
  assistant(proc, 'error', 'Context overflow')
  proc.emit({ type: 'compaction_end', result: { summary: 'summary' }, willRetry: true })
  assistant(proc, 'stop')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
})

test('cancellation wins over a failed attempt and exhausted retry', async () => {
  const { session, proc } = setup()
  const prompt = session.prompt('one')
  assistant(proc, 'error', '503 unavailable')
  await session.cancel()
  proc.emit({ type: 'auto_retry_end', success: false, finalError: 'Retry cancelled' })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
})

test('cancelled compaction does not claim success or override explicit prompt cancellation', async () => {
  const { session, proc, conn } = setup()
  const prompt = session.prompt('one')
  await session.cancel()
  proc.emit({ type: 'compaction_end', result: null, aborted: true })
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
  assert.deepEqual(texts(conn), [])
})

test('manual compaction progress is described as manual, and a failed tool does not fail the prompt', async () => {
  const { session, proc, conn } = setup()
  const prompt = session.prompt('one')
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'Summary' } })
  proc.emit({ type: 'message_end', message: { role: 'toolResult', isError: true, errorMessage: 'Missing file' } })
  assistant(proc, 'stop')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  assert.deepEqual(texts(conn), ['Compacting context...', 'Compaction finished; context was summarized.'])
})

test('final failure rejects the queue and a later explicit prompt can succeed', async () => {
  const { session, proc, conn } = setup()
  const first = assert.rejects(session.prompt('one'), /Quota reached/)
  const second = assert.rejects(session.prompt('two'), /Quota reached/)
  assistant(proc, 'error', 'Quota reached')
  proc.emit({ type: 'agent_settled' })
  await Promise.all([first, second])
  assert.equal(proc.prompts.length, 1)
  assert.deepEqual(conn.updates.at(-1)?.update._meta, { piAcp: { queueDepth: 0, running: false } })
  const next = session.prompt('three')
  assistant(proc, 'stop')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await next, 'end_turn')
  assert.deepEqual(
    proc.prompts.map(p => p.message),
    ['one', 'three']
  )
})

for (const failure of ['provider', 'rpc']) {
  test(`${failure} rejection waits for already streamed updates`, async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    class SlowConnection extends FakeAgentSideConnection {
      override async sessionUpdate(msg: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]) {
        if (msg.update.sessionUpdate === 'agent_message_chunk') await blocked
        await super.sessionUpdate(msg)
      }
    }
    let rejectRpc!: (reason: Error) => void
    class FailingProcess extends FakePiRpcProcess {
      override prompt() {
        return new Promise<void>((_, reject) => {
          rejectRpc = reject
        })
      }
    }
    const { session, proc, conn } = setup(new SlowConnection(), failure === 'rpc' ? new FailingProcess() : undefined)
    let done = false
    const rejected = assert.rejects(session.prompt('one'), /Failed/).finally(() => {
      done = true
    })
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Partial answer' } })
    if (failure === 'rpc') rejectRpc(new Error('Failed'))
    else {
      assistant(proc, 'error', 'Failed')
      proc.emit({ type: 'agent_settled' })
    }
    await tick()
    assert.equal(done, false)
    release()
    await rejected
    assert.deepEqual(texts(conn), ['Partial answer'])
  })
}

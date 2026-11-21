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

for (const [reasons, expected] of [
  [['length'], 'max_tokens'],
  [['length', 'stop'], 'end_turn'],
  [['stop', 'length'], 'max_tokens'],
  [['error', 'length'], 'max_tokens']
] as const) {
  test(`the last assistant completion determines the stop reason: ${reasons.join(', ')}`, async () => {
    const { session, proc } = setup()
    let done = false
    const prompt = session.prompt('one').finally(() => {
      done = true
    })
    for (const reason of reasons) {
      assistant(proc, reason, reason === 'error' ? 'Temporary failure' : undefined)
      proc.emit({ type: 'agent_end' })
    }
    proc.emit({ type: 'message_end', message: { role: 'toolResult', content: [] } })
    await tick()
    assert.equal(done, false)
    proc.emit({ type: 'agent_settled' })
    assert.equal(await prompt, expected)
  })
}

test('a final failure overrides an earlier token limit', async () => {
  const { session, proc } = setup()
  const failed = assert.rejects(session.prompt('one'), /Provider unavailable/)
  assistant(proc, 'length')
  assistant(proc, 'error', 'Provider unavailable')
  proc.emit({ type: 'agent_settled' })
  await failed
})

test('cancellation overrides a token limit', async () => {
  const { session, proc } = setup()
  const prompt = session.prompt('one')
  assistant(proc, 'length')
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'cancelled')
})

test('a token limit does not carry over to the next queued prompt', async () => {
  const { session, proc } = setup()
  const first = session.prompt('one')
  const second = session.prompt('two')
  assistant(proc, 'length')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await first, 'max_tokens')
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['one', 'two']
  )
  proc.emit({ type: 'agent_settled' })
  assert.equal(await second, 'end_turn')
})

for (const outcome of ['recovered', 'cancelled']) {
  test(`authentication failure stays provisional until the turn is ${outcome}`, async () => {
    const { session, proc, conn } = setup()
    let done = false
    const prompt = session.prompt('one').finally(() => {
      done = true
    })
    assistant(proc, 'error', '401: Token expired')
    proc.emit({ type: 'agent_end', willRetry: true })
    await tick()
    assert.equal(done, false)
    if (outcome === 'recovered') {
      assistant(proc, 'stop')
      proc.emit({ type: 'auto_retry_end', success: true })
    } else {
      await session.cancel()
      proc.emit({ type: 'auto_retry_end', success: false, finalError: '401: Token expired' })
    }
    proc.emit({ type: 'agent_settled' })
    assert.equal(await prompt, outcome === 'recovered' ? 'end_turn' : 'cancelled')
    assert.ok(texts(conn).every(text => !text.includes('401') && !text.includes('Token expired')))
  })
}

test('retry exhaustion reports finalError without claiming to resume', async () => {
  const { session, proc, conn } = setup()
  const failed = assert.rejects(session.prompt('one'), {
    code: -32603,
    message: 'Internal error: Provider unavailable (after 3 retries)'
  })
  proc.emit({ type: 'auto_retry_end', success: false, finalError: 'Provider unavailable', attempt: 3 })
  proc.emit({ type: 'agent_settled' })
  await failed
  assert.deepEqual(texts(conn), [])
})

test('retry exhaustion without finalError retains the last provider explanation', async () => {
  const { session, proc } = setup()
  const failed = assert.rejects(session.prompt('one'), {
    code: -32603,
    message: 'Internal error: 503: Service unavailable (after 1 retry)'
  })
  assistant(proc, 'error', '503: Service unavailable')
  proc.emit({ type: 'auto_retry_end', success: false, attempt: 1 })
  proc.emit({ type: 'agent_settled' })
  await failed
})

test('retry exhaustion omits missing or invalid attempt counts', async () => {
  for (const attempt of [undefined, null, 0, -1, 1.5, '3', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const { session, proc } = setup()
    const failed = assert.rejects(session.prompt('one'), {
      code: -32603,
      message: 'Internal error: Provider unavailable'
    })
    proc.emit({ type: 'auto_retry_end', success: false, finalError: 'Provider unavailable', attempt })
    proc.emit({ type: 'agent_settled' })
    await failed
  }
})

for (const [eventType, reason] of [
  ['compaction_end', 'threshold'],
  ['compaction_end', 'overflow'],
  ['auto_compaction_end', undefined]
]) {
  test(`${eventType} ${reason ?? 'legacy'} failure is visible and never reported as successful`, async () => {
    const { session, proc, conn } = setup()
    const failed = assert.rejects(session.prompt('one'), /Summary failed/)
    proc.emit({ type: eventType, reason, result: null, aborted: false, errorMessage: 'Summary failed' })
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

test('manual compaction emits no duplicate progress, and a failed tool does not fail the prompt', async () => {
  const { session, proc, conn } = setup()
  const prompt = session.prompt('one')
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'Summary' } })
  proc.emit({ type: 'message_end', message: { role: 'toolResult', isError: true, errorMessage: 'Missing file' } })
  assistant(proc, 'stop')
  proc.emit({ type: 'agent_settled' })
  assert.equal(await prompt, 'end_turn')
  assert.deepEqual(texts(conn), [])
})

for (const aborted of [false, true]) {
  test(`manual compaction ${aborted ? 'cancellation' : 'failure'} preserves successful and queued prompts`, async () => {
    const { session, proc, conn } = setup()
    const first = session.prompt('one').catch(error => error)
    const second = session.prompt('two').catch(error => error)
    assistant(proc, 'stop')
    proc.emit({ type: 'compaction_start', reason: 'manual' })
    proc.emit({ type: 'compaction_end', reason: 'manual', result: null, aborted, errorMessage: 'Summary failed' })
    proc.emit({ type: 'agent_settled' })
    assert.equal(await first, 'end_turn')
    assert.deepEqual(
      proc.prompts.map(prompt => prompt.message),
      ['one', 'two']
    )
    assistant(proc, 'stop')
    proc.emit({ type: 'agent_settled' })
    assert.equal(await second, 'end_turn')
    assert.deepEqual(texts(conn), ['Queued message (position 1).', 'Starting queued message. (0 remaining)'])
  })
}

test('manual compaction emits no event messages while idle', async () => {
  const { proc, conn } = setup()
  proc.emit({ type: 'compaction_start', reason: 'manual' })
  proc.emit({ type: 'compaction_end', reason: 'manual', result: { summary: 'Summary' } })
  await tick()
  assert.deepEqual(texts(conn), [])
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

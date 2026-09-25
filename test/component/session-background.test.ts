import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError, type SessionUpdate } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(
  proc = new FakePiRpcProcess(),
  conn = new FakeAgentSideConnection(),
  options: { sessionId?: string } = {}
) {
  const session = new PiAcpSession({
    sessionId: options.sessionId ?? 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn),
    fileCommands: []
  })
  return { session, proc, conn }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function observe<T>(promise: Promise<T>) {
  const state = { settled: false }
  void promise.then(
    () => {
      state.settled = true
    },
    () => {
      state.settled = true
    }
  )
  return state
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve))
const child = (id: string) => ({ id, title: `Worker ${id}` })

function snapshot(
  proc: FakePiRpcProcess,
  active: string[],
  idle: boolean,
  finished?: { id: string; status: 'completed' | 'failed'; text?: string }
) {
  proc.emit({
    type: 'background_work',
    version: 1,
    active: active.map(child),
    idle,
    ...(finished ? { finished: { ...child(finished.id), ...finished } } : {})
  })
}

function settleParent(proc: FakePiRpcProcess) {
  proc.emit({ type: 'turn_end' })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'agent_settled' })
}

function toolUpdates(conn: FakeAgentSideConnection, id: string) {
  return conn.updates
    .map(entry => entry.update)
    .filter(
      (update): update is Extract<SessionUpdate, { sessionUpdate: 'tool_call' | 'tool_call_update' }> =>
        (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
        update.toolCallId === `background:${id}`
    )
}

function runningUpdates(conn: FakeAgentSideConnection) {
  return conn.updates.flatMap(({ update }) => {
    if (update.sessionUpdate !== 'session_info_update') return []
    const running = (update._meta as { piAcp?: { running?: unknown } } | undefined)?.piAcp?.running
    return typeof running === 'boolean' ? [running] : []
  })
}

test('PiAcpSession: an ordinary prompt still completes at native settlement', async () => {
  const { session, proc } = createSession()
  const prompt = session.prompt('hello')
  proc.emit({ type: 'agent_start' })
  settleParent(proc)
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: a recovered continuation error can still complete the operation', async () => {
  const { session, proc } = createSession()
  const prompt = session.prompt('continue')
  proc.emit({ type: 'agent_start' })
  proc.emit({
    type: 'message_end',
    message: { role: 'assistant', stopReason: 'error', errorMessage: 'temporary failure' }
  })
  proc.emit({ type: 'agent_end' })
  proc.emit({ type: 'auto_retry_start' })
  proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
  settleParent(proc)
  assert.equal(await prompt, 'end_turn')
  assert.equal(proc.abortCount, 0)
})

test('PiAcpSession: a terminal continuation error stops owned work, rejects the queue, and allows a new prompt', async () => {
  const { session, proc, conn } = createSession()
  const stopped = deferred<void>()
  proc.abort = async () => {
    await stopped.promise
    proc.emit({ type: 'background_cancelled' })
  }
  const prompt = session.prompt('delegate')
  const queued = session.prompt('queued')
  const rejected = assert.rejects(prompt, (error: unknown) => {
    assert.ok(error instanceof RequestError)
    assert.match(error.message, /503: provider unavailable/)
    assert.equal(error.message.includes('request_id'), false)
    assert.equal(error.data, undefined)
    return true
  })
  const queueRejected = assert.rejects(queued, /provider unavailable/)
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['child'], false)
  proc.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: '503: {"error":{"message":"provider unavailable"},"request_id":"internal"}'
    }
  })
  settleParent(proc)
  await flush()
  assert.equal(state.settled, false)
  stopped.resolve()
  await Promise.all([rejected, queueRejected])
  assert.equal(
    conn.updates.some(
      ({ update }) =>
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content.type === 'text' &&
        update.content.text.includes('provider unavailable')
    ),
    false
  )
  const next = session.prompt('new request')
  proc.emit({ type: 'agent_start' })
  settleParent(proc)
  assert.equal(await next, 'end_turn')
  assert.equal(proc.prompts.length, 2)
})

test('PiAcpSession: background completion waits for the parent continuation to settle', async () => {
  const { session, proc, conn } = createSession()
  const prompt = session.prompt('delegate a task')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  settleParent(proc)
  await flush()
  assert.equal(state.settled, false)
  assert.deepEqual(
    toolUpdates(conn, 'a').map(update => update.status),
    ['in_progress']
  )

  snapshot(proc, [], false, { id: 'a', status: 'completed', text: 'Checks passed' })
  await flush()
  assert.equal(state.settled, false)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, [], true)
  await flush()
  assert.equal(state.settled, false)
  settleParent(proc)

  assert.equal(await prompt, 'end_turn')
  assert.deepEqual(
    toolUpdates(conn, 'a').map(update => update.status),
    ['in_progress', 'completed']
  )
})

test('PiAcpSession: idle background completion releases an already settled parent', async () => {
  const { session, proc } = createSession()
  const prompt = session.prompt('delegate a task')
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  settleParent(proc)
  await flush()
  snapshot(proc, [], true, { id: 'a', status: 'completed' })
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: idle snapshot before native settlement does not finish a running parent', async () => {
  const { session, proc } = createSession()
  const prompt = session.prompt('finish immediately')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  snapshot(proc, [], true, { id: 'a', status: 'completed' })
  await flush()
  assert.equal(state.settled, false)
  settleParent(proc)
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: terminal-only background completion is shown once', async () => {
  const { session, proc, conn } = createSession()
  const prompt = session.prompt('delegate a task')
  proc.emit({ type: 'agent_start' })
  snapshot(proc, [], true, { id: 'a', status: 'failed', text: 'Quota exceeded' })
  snapshot(proc, [], true, { id: 'a', status: 'failed', text: 'Duplicate' })
  await flush()
  assert.equal(toolUpdates(conn, 'a').length, 1)
  const [finished] = toolUpdates(conn, 'a')
  assert.equal(finished?.sessionUpdate, 'tool_call')
  assert.equal(finished?.title, 'Worker a')
  assert.equal(finished?.status, 'failed')
  assert.deepEqual(finished?.content, [{ type: 'content', content: { type: 'text', text: 'Quota exceeded' } }])
  settleParent(proc)
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: idle background state before a prompt does not report running', async () => {
  const { proc, conn } = createSession()
  snapshot(proc, [], true)
  await flush()
  assert.deepEqual(runningUpdates(conn), [])
})

test('PiAcpSession: multiple jobs and duplicate completion keep one lifecycle per job', async () => {
  const { session, proc, conn } = createSession()
  const prompt = session.prompt('delegate two tasks')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a', 'b'], false)
  snapshot(proc, ['a', 'b'], false)
  settleParent(proc)
  snapshot(proc, ['b'], false, { id: 'a', status: 'completed' })
  snapshot(proc, ['b'], false, { id: 'a', status: 'completed' })
  await flush()
  assert.equal(state.settled, false)
  assert.deepEqual(
    toolUpdates(conn, 'a').map(update => update.status),
    ['in_progress', 'completed']
  )
  assert.deepEqual(
    toolUpdates(conn, 'b').map(update => update.status),
    ['in_progress']
  )

  snapshot(proc, [], true, { id: 'b', status: 'completed' })
  assert.equal(await prompt, 'end_turn')
  assert.deepEqual(
    toolUpdates(conn, 'b').map(update => update.status),
    ['in_progress', 'completed']
  )
})

test('PiAcpSession: queued prompts start only after background work and continuation settle', async () => {
  const { session, proc } = createSession()
  const first = session.prompt('one')
  const second = session.prompt('two')
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  settleParent(proc)
  await flush()
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['one']
  )

  snapshot(proc, [], false, { id: 'a', status: 'completed' })
  proc.emit({ type: 'agent_start' })
  snapshot(proc, [], true)
  await flush()
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['one']
  )
  settleParent(proc)
  assert.equal(await first, 'end_turn')
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['one', 'two']
  )

  proc.emit({ type: 'agent_start' })
  snapshot(proc, [], true)
  settleParent(proc)
  assert.equal(await second, 'end_turn')
})

test('PiAcpSession: cancellation clears queued prompts but waits for verified shutdown', async () => {
  const aborted = deferred<void>()
  class DelayedAbortProcess extends FakePiRpcProcess {
    override async abort(): Promise<void> {
      this.abortCount += 1
      await aborted.promise
    }
  }
  const { session, proc, conn } = createSession(new DelayedAbortProcess())
  const prompt = session.prompt('delegate a task')
  const queued = session.prompt('later')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  settleParent(proc)
  await flush()
  const cancellation = session.cancel()
  assert.equal(await queued, 'cancelled')
  assert.equal(proc.abortCount, 1)

  snapshot(proc, [], true, { id: 'a', status: 'completed' })
  settleParent(proc)
  await flush()
  assert.equal(state.settled, false)
  proc.emit({ type: 'background_cancelled' })
  aborted.resolve()
  await cancellation
  assert.equal(await prompt, 'cancelled')
  assert.equal(state.settled, true)
  assert.deepEqual(
    proc.prompts.map(prompt => prompt.message),
    ['delegate a task']
  )
  assert.notEqual(toolUpdates(conn, 'a').at(-1)?.status, 'in_progress')
})

test('PiAcpSession: failed child tools do not fail the ACP prompt', async () => {
  const { session, proc, conn } = createSession()
  const prompt = session.prompt('delegate a task')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  settleParent(proc)
  snapshot(proc, [], false, { id: 'a', status: 'failed', text: 'A child check failed' })
  await flush()
  assert.equal(state.settled, false)
  assert.equal(toolUpdates(conn, 'a').at(-1)?.status, 'failed')
  proc.emit({ type: 'agent_start' })
  snapshot(proc, [], true)
  settleParent(proc)
  assert.equal(await prompt, 'end_turn')
})

test('PiAcpSession: verified cancellation finishes every still-running background row', async () => {
  const { session, proc, conn } = createSession()
  const prompt = session.prompt('delegate two tasks')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a', 'b'], false)
  settleParent(proc)
  await flush()
  await session.cancel()
  proc.emit({ type: 'agent_settled' })
  await flush()
  assert.equal(state.settled, false)
  assert.equal(toolUpdates(conn, 'a').at(-1)?.status, 'in_progress')
  assert.equal(toolUpdates(conn, 'b').at(-1)?.status, 'in_progress')

  proc.emit({ type: 'background_cancelled' })
  assert.equal(await prompt, 'cancelled')
  assert.equal(toolUpdates(conn, 'a').at(-1)?.status, 'failed')
  assert.equal(toolUpdates(conn, 'b').at(-1)?.status, 'failed')
})

test('PiAcpSession: process failure rejects active and queued requests and prevents reuse', async () => {
  const { session, proc, conn } = createSession()
  const prompt = session.prompt('delegate a task')
  const queued = session.prompt('later')
  const isProcessError = (error: unknown) => {
    assert.ok(error instanceof RequestError)
    assert.match(error.message, /process disappeared/)
    return true
  }
  const activeRejected = assert.rejects(prompt, isProcessError)
  const queuedRejected = assert.rejects(queued, isProcessError)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  settleParent(proc)
  proc.emit({ type: 'process_error', message: 'process disappeared' })
  await Promise.all([activeRejected, queuedRejected])
  await assert.rejects(session.prompt('retry'), RequestError)
  await flush()
  assert.equal(toolUpdates(conn, 'a').at(-1)?.status, 'failed')
  assert.equal(proc.prompts.length, 1)
})

test('PiAcpSession: background activity in one session does not hold another session open', async () => {
  const conn = new FakeAgentSideConnection()
  const first = createSession(new FakePiRpcProcess(), conn, { sessionId: 'first' })
  const second = createSession(new FakePiRpcProcess(), conn, { sessionId: 'second' })
  const busy = first.session.prompt('delegate a task')
  const busyState = observe(busy)
  const ordinary = second.session.prompt('hello')
  first.proc.emit({ type: 'agent_start' })
  second.proc.emit({ type: 'agent_start' })
  snapshot(first.proc, ['a'], false)
  settleParent(first.proc)
  settleParent(second.proc)
  assert.equal(await ordinary, 'end_turn')
  assert.equal(busyState.settled, false)
  snapshot(first.proc, [], true, { id: 'a', status: 'completed' })
  assert.equal(await busy, 'end_turn')
  assert.ok(conn.updates.filter(entry => 'toolCallId' in entry.update).every(entry => entry.sessionId === 'first'))
})

test('PiAcpSession: new activity while flushing notifications invalidates pending settlement', async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  class DelayedConnection extends FakeAgentSideConnection {
    override async sessionUpdate(message: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]) {
      if (message.update.sessionUpdate === 'agent_message_chunk') {
        entered.resolve()
        await release.promise
      }
      await super.sessionUpdate(message)
    }
  }
  const { session, proc } = createSession(new FakePiRpcProcess(), new DelayedConnection())
  const prompt = session.prompt('delegate after settlement starts')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Working' } })
  settleParent(proc)
  await entered.promise

  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  release.resolve()
  await flush()
  assert.equal(state.settled, false)
  snapshot(proc, [], true, { id: 'a', status: 'completed' })
  await flush()
  assert.equal(state.settled, false)
  settleParent(proc)
  assert.equal(await prompt, 'end_turn')
})

for (const activity of ['parent', 'background']) {
  test(`PiAcpSession: renewed ${activity} activity restores running after terminal status delivery starts`, async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    class DelayedConnection extends FakeAgentSideConnection {
      override async sessionUpdate(message: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]) {
        const running = (message.update._meta as { piAcp?: { running?: unknown } } | undefined)?.piAcp?.running
        if (running === false) {
          entered.resolve()
          await release.promise
        }
        await super.sessionUpdate(message)
      }
    }
    const conn = new DelayedConnection()
    const { session, proc } = createSession(new FakePiRpcProcess(), conn)
    const prompt = session.prompt('continue after completion starts')
    const state = observe(prompt)
    proc.emit({ type: 'agent_start' })
    settleParent(proc)
    await entered.promise

    if (activity === 'parent') proc.emit({ type: 'agent_start' })
    else snapshot(proc, ['a'], false)
    release.resolve()
    await flush()
    assert.equal(state.settled, false)
    assert.deepEqual(runningUpdates(conn).slice(-2), [false, true])

    if (activity === 'background') snapshot(proc, [], true, { id: 'a', status: 'completed' })
    else settleParent(proc)
    assert.equal(await prompt, 'end_turn')
  })
}

test('PiAcpSession: a repeated Stop releases a no-op background cancellation', async () => {
  const entered = deferred<void>()
  const releaseStatus = deferred<void>()
  class DelayedConnection extends FakeAgentSideConnection {
    override async sessionUpdate(message: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]) {
      const running = (message.update._meta as { piAcp?: { running?: unknown } } | undefined)?.piAcp?.running
      if (running === false) {
        entered.resolve()
        await releaseStatus.promise
      }
      await super.sessionUpdate(message)
    }
  }
  class RepeatedStopProcess extends FakePiRpcProcess {
    override async abort(): Promise<void> {
      this.abortCount += 1
      if (this.abortCount === 1) {
        this.emit({ type: 'background_cancelled' })
      }
    }
  }
  const proc = new RepeatedStopProcess()
  const { session } = createSession(proc, new DelayedConnection())
  const prompt = session.prompt('delegate a task')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  settleParent(proc)

  await session.cancel()
  await entered.promise
  await session.cancel()
  releaseStatus.resolve()
  await flush()
  const settled = state.settled
  if (!settled) proc.emit({ type: 'background_cancelled' })
  assert.equal(await prompt, 'cancelled')
  assert.equal(settled, true)
})

test('PiAcpSession: a continuation settling before the old flush completes still releases its prompt', async () => {
  const entered = deferred<void>()
  const release = deferred<void>()
  class DelayedConnection extends FakeAgentSideConnection {
    override async sessionUpdate(message: Parameters<FakeAgentSideConnection['sessionUpdate']>[0]) {
      if (message.update.sessionUpdate === 'agent_message_chunk') {
        entered.resolve()
        await release.promise
      }
      await super.sessionUpdate(message)
    }
  }
  const { session, proc } = createSession(new FakePiRpcProcess(), new DelayedConnection())
  const prompt = session.prompt('delegate after settlement starts')
  const state = observe(prompt)
  proc.emit({ type: 'agent_start' })
  proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Working' } })
  settleParent(proc)
  await entered.promise

  proc.emit({ type: 'agent_start' })
  snapshot(proc, ['a'], false)
  snapshot(proc, [], true, { id: 'a', status: 'completed' })
  settleParent(proc)
  assert.equal(state.settled, false)
  release.resolve()
  assert.equal(await prompt, 'end_turn')
})

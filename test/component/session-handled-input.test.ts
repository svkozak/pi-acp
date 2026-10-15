import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTick } from 'node:timers/promises'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess, PiSessionStats } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fixture() {
  const proc = new FakePiRpcProcess()
  const acknowledgements: ReturnType<typeof deferred<unknown>>[] = []
  const transport = Object.assign(proc, {
    prompt(message: string, attachments: unknown[] = []) {
      proc.prompts.push({ message, attachments })
      const ack = deferred<unknown>()
      acknowledgements.push(ack)
      return ack.promise
    }
  })
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: transport as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  return { proc, session, acknowledgements }
}

function observe(promise: Promise<unknown>) {
  const result: unknown[] = []
  void promise.then(
    value => result.push(value),
    error => result.push(error)
  )
  return result
}

test('handled input completes and advances queued and subsequent prompts', async () => {
  const { session, acknowledgements, proc } = fixture()
  const first = observe(session.prompt('first'))
  const second = observe(session.prompt('second'))
  acknowledgements[0].resolve('handled')
  await nextTick()
  assert.deepEqual(first, ['end_turn'])
  assert.equal(proc.prompts.length, 2)
  acknowledgements[1].resolve('handled')
  await nextTick()
  assert.deepEqual(second, ['end_turn'])
  const third = observe(session.prompt('third'))
  acknowledgements[2].resolve('handled')
  await nextTick()
  assert.deepEqual(third, ['end_turn'])
})

for (const endBeforeAck of [false, true]) {
  test(`handled acknowledgment waits for model settlement (agent_end=${endBeforeAck})`, async () => {
    const { session, acknowledgements, proc } = fixture()
    const result = observe(session.prompt('first'))
    proc.emit({ type: 'agent_start' })
    if (endBeforeAck) proc.emit({ type: 'agent_end' })
    acknowledgements[0].resolve('handled')
    await nextTick()
    assert.deepEqual(result, [])
    proc.emit({ type: 'agent_settled' })
    await nextTick()
    assert.deepEqual(result, ['end_turn'])
  })
}

for (const disposition of [undefined, 'started', 'queued', 'unknown']) {
  test(`non-terminal disposition ${disposition} waits for settlement`, async () => {
    const { session, acknowledgements, proc } = fixture()
    const result = observe(session.prompt('first'))
    acknowledgements[0].resolve(disposition)
    await nextTick()
    assert.deepEqual(result, [])
    proc.emit({ type: 'agent_settled' })
    await nextTick()
    assert.deepEqual(result, ['end_turn'])
  })
}

test('cancelled handled input completes as cancelled', async () => {
  const { session, acknowledgements } = fixture()
  const result = observe(session.prompt('first'))
  await session.cancel()
  acknowledgements[0].resolve('handled')
  await nextTick()
  assert.deepEqual(result, ['cancelled'])
})

for (const lateOutcome of ['handled', 'error']) {
  test(`late ${lateOutcome} response cannot settle a successor`, async () => {
    const { session, acknowledgements, proc } = fixture()
    const first = observe(session.prompt('first'))
    const second = observe(session.prompt('second'))
    proc.emit({ type: 'agent_settled' })
    await nextTick()
    assert.deepEqual(first, ['end_turn'])
    if (lateOutcome === 'handled') acknowledgements[0].resolve('handled')
    else acknowledgements[0].reject(new Error('old prompt error'))
    await nextTick()
    assert.deepEqual(second, [])
    proc.emit({ type: 'agent_settled' })
    await nextTick()
    assert.deepEqual(second, ['end_turn'])
  })
}

test('handled completion and duplicate settlement cannot advance the queue twice', async () => {
  const { session, acknowledgements, proc } = fixture()
  const stats = deferred<PiSessionStats>()
  proc.getSessionStats = () => stats.promise
  const first = observe(session.prompt('first'))
  const second = observe(session.prompt('second'))
  acknowledgements[0].resolve('handled')
  await nextTick()
  proc.emit({ type: 'agent_settled' })
  proc.emit({ type: 'agent_settled' })
  stats.resolve({})
  await nextTick()
  assert.deepEqual(first, ['end_turn'])
  assert.deepEqual(second, [])
  assert.equal(proc.prompts.length, 2)
  acknowledgements[1].resolve('handled')
  await nextTick()
  assert.deepEqual(second, ['end_turn'])
})

test('model work starting during auxiliary usage collection prevents idle completion', async () => {
  const { session, acknowledgements, proc } = fixture()
  const stats = deferred<PiSessionStats>()
  proc.getSessionStats = () => stats.promise
  const result = observe(session.prompt('first'))
  acknowledgements[0].resolve('handled')
  await nextTick()
  proc.emit({ type: 'agent_start' })
  stats.resolve({})
  await nextTick()
  assert.deepEqual(result, [])
  proc.emit({ type: 'agent_settled' })
  await nextTick()
  assert.deepEqual(result, ['end_turn'])
})

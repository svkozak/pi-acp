import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { PiRpcProcess, SESSION_STATS_TIMEOUT_MS } from '../../src/pi-rpc/process.js'

type FakeChild = {
  child: any
  stdout: PassThrough
  written: string[]
}

function makeFakeChild(): FakeChild {
  const stdout = new PassThrough()
  const written: string[] = []
  const child: any = new EventEmitter()
  child.stdout = stdout
  child.stderr = new PassThrough()
  child.killed = false
  child.kill = () => {}
  child.stdin = new PassThrough()
  child.stdin.write = (line: string, cb?: (error?: Error | null) => void) => {
    written.push(String(line))
    cb?.(null)
    return true
  }
  return { child, stdout, written }
}

// The constructor is private in TS only; tests drive it directly to avoid spawning `pi`.
function makeProcess(child: any): PiRpcProcess {
  return new (PiRpcProcess as unknown as new (c: any) => PiRpcProcess)(child)
}

function pendingSize(proc: PiRpcProcess): number {
  return (proc as unknown as { pending: Map<string, unknown> }).pending.size
}

function writeLine(stdout: PassThrough, msg: unknown): Promise<void> {
  stdout.write(`${JSON.stringify(msg)}\n`)
  return new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)))
}

test('PiRpcProcess: auxiliary context usage has a one-second timeout', () => {
  assert.equal(SESSION_STATS_TIMEOUT_MS, 1_000)
})

test('PiRpcProcess: getSessionStats without a timeout accepts a response after one second', async () => {
  const { child, stdout, written } = makeFakeChild()
  const proc = makeProcess(child)

  const result = proc.getSessionStats()
  const sent = JSON.parse(written[0]) as { id: string }

  await new Promise(resolve => setTimeout(resolve, SESSION_STATS_TIMEOUT_MS + 50))
  assert.equal(pendingSize(proc), 1)

  await writeLine(stdout, {
    type: 'response',
    id: sent.id,
    command: 'get_session_stats',
    success: true,
    data: { totalMessages: 42 }
  })

  assert.deepEqual(await result, { totalMessages: 42 })
  assert.equal(pendingSize(proc), 0)
})

test('PiRpcProcess: request timeout rejects, clears pending, and swallows the late response', async () => {
  const { child, stdout, written } = makeFakeChild()
  const proc = makeProcess(child)

  const events: unknown[] = []
  proc.onEvent(ev => events.push(ev))

  // The request timer is unref'd; keep the test process alive until it fires.
  const keepAlive = setTimeout(() => {}, 50)
  try {
    await assert.rejects(proc.getSessionStats(5), /pi get_session_stats timed out after 5ms/)
  } finally {
    clearTimeout(keepAlive)
  }
  assert.equal(pendingSize(proc), 0)

  const sent = JSON.parse(written[0]) as { id: string; type: string }
  assert.equal(sent.type, 'get_session_stats')

  await writeLine(stdout, {
    type: 'response',
    id: sent.id,
    command: 'get_session_stats',
    success: true,
    data: { contextUsage: { tokens: 1, contextWindow: 2 } }
  })

  assert.deepEqual(events, [])
  assert.equal(pendingSize(proc), 0)
})

test('PiRpcProcess: response before the timeout resolves and clears pending', async () => {
  const { child, stdout, written } = makeFakeChild()
  const proc = makeProcess(child)

  const events: unknown[] = []
  proc.onEvent(ev => events.push(ev))

  const p = proc.getSessionStats(5_000)
  const sent = JSON.parse(written[0]) as { id: string }

  await writeLine(stdout, {
    type: 'response',
    id: sent.id,
    command: 'get_session_stats',
    success: true,
    data: { contextUsage: { tokens: 10, contextWindow: 100 } }
  })

  assert.deepEqual(await p, { contextUsage: { tokens: 10, contextWindow: 100 } })
  assert.equal(pendingSize(proc), 0)
  assert.deepEqual(events, [])
})

test('PiRpcProcess: responses with unknown ids are dropped while real events are delivered', async () => {
  const { child, stdout } = makeFakeChild()
  const proc = makeProcess(child)

  const events: unknown[] = []
  proc.onEvent(ev => events.push(ev))

  await writeLine(stdout, { type: 'response', id: 'nope', command: 'get_state', success: true, data: {} })
  await writeLine(stdout, { type: 'response', command: 'get_state', success: true, data: {} })
  await writeLine(stdout, { type: 'agent_start' })

  assert.deepEqual(events, [{ type: 'agent_start' }])
})

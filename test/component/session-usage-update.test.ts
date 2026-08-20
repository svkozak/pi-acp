import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

const doneEvent = (usage: unknown, provider = 'openai', model = 'gpt-x') => ({
  type: 'message_update' as const,
  assistantMessageEvent: {
    type: 'done',
    reason: 'stop',
    message: { role: 'assistant', provider, model, usage, stopReason: 'stop' }
  }
})

test('PiAcpSession: emits usage_update when an assistant message completes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => ({
    models: [{ provider: 'openai', id: 'gpt-x', contextWindow: 128000 }]
  })

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(doneEvent({ input: 1000, output: 200, cacheRead: 50, cacheWrite: 0 }) as any)

  await new Promise(r => setTimeout(r, 10))

  assert.equal(conn.updates.length, 1)
  assert.deepEqual(conn.updates[0]!.update, {
    sessionUpdate: 'usage_update',
    used: 1250,
    size: 128000
  })
})

test('PiAcpSession: reports usage only for a completed message', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => ({
    models: [{ provider: 'openai', id: 'gpt-x', contextWindow: 128000 }]
  })

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Both of these carry an assistant message with usage on it, and neither is
  // a completed one: `text_end` is mid-stream and cumulative, and pi treats an
  // errored message's usage as invalid.
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_end',
      contentIndex: 0,
      content: 'hi',
      partial: { role: 'assistant', provider: 'openai', model: 'gpt-x', usage: { totalTokens: 12 } }
    }
  } as any)
  proc.emit({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'error',
      reason: 'error',
      error: { role: 'assistant', provider: 'openai', model: 'gpt-x', usage: { totalTokens: 34 } }
    }
  } as any)
  proc.emit(doneEvent({ totalTokens: 4096 }) as any)

  await new Promise(r => setTimeout(r, 10))

  const usage = conn.updates.filter(u => (u.update as any).sessionUpdate === 'usage_update')
  assert.equal(usage.length, 1)
  assert.deepEqual(usage[0]!.update, { sessionUpdate: 'usage_update', used: 4096, size: 128000 })
})

test('PiAcpSession: says nothing when the model reports no context window', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => ({ models: [{ provider: 'openai', id: 'gpt-x' }] })

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(doneEvent({ totalTokens: 4096 }) as any)

  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(conn.updates, [])
})

test('PiAcpSession: an unreadable model list does not break the turn', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => {
    throw new Error('pi is not answering')
  }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(doneEvent({ totalTokens: 4096 }) as any)

  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(conn.updates, [])
})

test('PiAcpSession: looks up the model list once, then reuses the window', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  let lookups = 0
  proc.getAvailableModels = async () => {
    lookups += 1
    return { models: [{ provider: 'openai', id: 'gpt-x', contextWindow: 128000 }] }
  }

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(doneEvent({ totalTokens: 100 }) as any)
  await new Promise(r => setTimeout(r, 10))
  proc.emit(doneEvent({ totalTokens: 200 }) as any)
  await new Promise(r => setTimeout(r, 10))

  assert.equal(lookups, 1)
  assert.deepEqual(
    conn.updates.map(u => (u.update as any).used),
    [100, 200]
  )
})

test('PiAcpSession: a second model gets its own window', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  proc.getAvailableModels = async () => ({
    models: [
      { provider: 'openai', id: 'gpt-x', contextWindow: 128000 },
      { provider: 'local', id: 'gpt-x', contextWindow: 8192 }
    ]
  })

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit(doneEvent({ totalTokens: 100 }, 'openai', 'gpt-x') as any)
  await new Promise(r => setTimeout(r, 10))
  proc.emit(doneEvent({ totalTokens: 200 }, 'local', 'gpt-x') as any)
  await new Promise(r => setTimeout(r, 10))

  assert.deepEqual(
    conn.updates.map(u => (u.update as any).size),
    [128000, 8192]
  )
})

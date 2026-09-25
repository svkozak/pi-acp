import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import backgroundExtension from '../../src/pi-rpc/background-extension.js'
import {
  BACKGROUND_COMMAND,
  BACKGROUND_STATUS_KEY,
  type BackgroundMessage
} from '../../src/pi-rpc/background-protocol.js'

type Api = Parameters<typeof backgroundExtension>[0]
type Context = Parameters<Parameters<Api['registerCommand']>[1]['handler']>[1]

function harness(enabled = true, mode = 'rpc') {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: Context) => unknown>()
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const commands = new Map<string, Parameters<Api['registerCommand']>[1]>()
  const messages: BackgroundMessage[] = []
  let idle = true
  let pending = false
  const context: Context = {
    mode,
    ui: {
      setStatus(key, value) {
        assert.equal(key, BACKGROUND_STATUS_KEY)
        messages.push(JSON.parse(value!))
      }
    },
    sessionManager: { getSessionFile: () => '/session.jsonl' },
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    abort() {
      idle = true
    },
    async waitForIdle() {}
  }
  const api: Api = {
    on(event, handler) {
      handlers.set(event, handler)
    },
    registerCommand(name, options) {
      commands.set(name, options)
    },
    events: {
      on(event, handler) {
        const group = listeners.get(event) ?? new Set()
        group.add(handler)
        listeners.set(event, group)
        return () => {
          group.delete(handler)
        }
      },
      emit(event, value) {
        for (const handler of listeners.get(event) ?? []) handler(value)
      }
    }
  }
  if (enabled) process.env.PI_ACP_BACKGROUND_BRIDGE = '1'
  else delete process.env.PI_ACP_BACKGROUND_BRIDGE
  backgroundExtension(api)
  const event = (name: string, data = {}) => handlers.get(name)?.(data, context)
  event('session_start')
  return {
    messages,
    context,
    api,
    event,
    state(nextIdle: boolean, nextPending = false) {
      idle = nextIdle
      pending = nextPending
    },
    start(id: string, extra = {}) {
      api.events.emit('subagent:async-started', { id, sessionId: '/session.jsonl', agent: 'worker', ...extra })
    },
    complete(id: string, extra = {}) {
      api.events.emit('subagent:async-complete', { runId: id, sessionId: '/session.jsonl', success: true, ...extra })
    },
    proof(id: string, state = 'observed') {
      api.events.emit('subagent:process-terminal', { version: 1, runId: id, state })
    },
    cancel() {
      return commands.get(BACKGROUND_COMMAND)?.handler('cancel', context)
    },
    rpc(reply: (method: string, id: string) => unknown) {
      api.events.on('subagents:rpc:v1:request', value => {
        const request = value as { requestId: string; method: string; params: { id: string } }
        const result = reply(request.method, request.params.id)
        api.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
          version: 1,
          requestId: request.requestId,
          ...(result as object)
        })
      })
    }
  }
}

function lastSnapshot(h: ReturnType<typeof harness>) {
  const message = h.messages.filter(message => message.type === 'snapshot').at(-1)
  assert.ok(message?.type === 'snapshot')
  return message
}

test('bridge requires explicit RPC activation and retains ownership only for its process', () => {
  assert.equal(harness(false).messages.length, 0)
  assert.equal(harness(true, 'json').messages.length, 0)
  const h = harness()
  assert.equal(process.env.PI_ACP_BACKGROUND_BRIDGE, String(process.pid))
  assert.equal(h.messages[0].type, 'ready')
})

test('subagent launch is blocked before execution when the installed runtime lacks lifecycle support', async () => {
  const h = harness()
  h.rpc(() => ({ success: true, data: { capabilities: { stop: true }, events: {} } }))
  const result = await h.event('tool_call', { toolName: 'subagent' })
  assert.ok(result && typeof result === 'object' && 'block' in result && result.block === true)
  assert.ok(h.messages.some(message => message.type === 'error' && /lifecycle unavailable/i.test(message.message)))
})

test('subagent launch uses the supported runtime contract without adding model messages', async () => {
  const h = harness()
  h.rpc(() => ({
    success: true,
    data: {
      capabilities: { stop: true, processTerminalProof: { version: 1 } },
      events: { asyncComplete: 'subagent:async-complete' }
    }
  }))
  assert.equal(await h.event('tool_call', { toolName: 'subagent' }), undefined)
})

test('registration keeps delayed jobs active across parent settlement and filters sessions', () => {
  const h = harness()
  h.state(false)
  h.start('one')
  h.start('other', { sessionId: '/other.jsonl' })
  h.start('one')
  h.state(true)
  h.event('agent_settled')
  assert.deepEqual(
    lastSnapshot(h).active.map(job => job.id),
    ['one']
  )
  assert.equal(lastSnapshot(h).idle, true)
  h.state(false)
  h.complete('one')
  assert.equal(lastSnapshot(h).active.length, 0)
  assert.equal(lastSnapshot(h).idle, false)
  h.state(true)
  h.event('agent_settled')
  assert.equal(lastSnapshot(h).idle, true)
})

test('queued completion and active continuation cannot report idle', () => {
  const h = harness()
  h.start('one')
  h.state(true, true)
  h.complete('one')
  assert.equal(lastSnapshot(h).idle, false)
  h.state(false)
  h.event('agent_start')
  assert.equal(lastSnapshot(h).idle, false)
})

test('workflow completion does not release a detached child that is still running', () => {
  const h = harness()
  h.event('tool_result', { toolName: 'subagent', details: { asyncId: 'flow', runId: 'flow', mode: 'workflow' } })
  h.start('child', { parentWorkflowRunId: 'flow' })
  assert.deepEqual(
    lastSnapshot(h).active.map(job => job.id),
    ['flow', 'child']
  )
  h.complete('flow')
  assert.deepEqual(
    lastSnapshot(h).active.map(job => job.id),
    ['child']
  )
  h.complete('child')
  assert.deepEqual(lastSnapshot(h).active, [])
})

test('immediate completion before tool result and duplicate completion cannot resurrect a job', () => {
  const h = harness()
  h.complete('flow', { success: false, summary: 'quota exhausted', agent: 'worker' })
  assert.deepEqual(lastSnapshot(h).finished, {
    id: 'flow',
    title: 'worker',
    status: 'failed',
    text: 'quota exhausted'
  })
  h.event('tool_result', { toolName: 'subagent', details: { asyncId: 'flow', runId: 'flow', mode: 'workflow' } })
  h.start('flow')
  h.complete('flow')
  const snapshots = h.messages.filter(message => message.type === 'snapshot')
  assert.ok(snapshots.every(message => message.active.length === 0))
  assert.equal(snapshots.filter(message => message.finished?.id === 'flow').length, 1)
})

test('cancellation stops the group, requires process proof, and blocks subsequent tools', async () => {
  const h = harness()
  const stopped: string[] = []
  h.start('one')
  h.start('two')
  h.rpc((method, id) => {
    if (method === 'stop') {
      stopped.push(id)
      return { success: true, data: { state: 'stopping' } }
    }
    return {
      success: true,
      data: { details: { lifecycleStatus: { processTerminal: { version: 1, runId: id, state: 'observed' } } } }
    }
  })
  const cancellation = h.cancel()
  assert.deepEqual(h.event('tool_call'), { block: true, reason: 'ACP operation is being cancelled' })
  await cancellation
  assert.deepEqual(stopped.sort(), ['one', 'two'])
  assert.deepEqual(h.messages.at(-1), { version: 1, type: 'cancelled' })
  assert.ok(h.event('tool_call'))
})

test('stop acceptance waits for a later process-terminal event', async () => {
  const h = harness()
  h.start('one')
  h.rpc(() => ({ success: true, data: { state: 'stopping' } }))
  const cancellation = h.cancel()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!h.messages.some(message => message.type === 'cancelled'))
  h.proof('one')
  await cancellation
  assert.deepEqual(h.messages.at(-1), { version: 1, type: 'cancelled' })
})

test('cancellation drains an in-flight launch before acknowledging an initially empty inventory', async () => {
  const h = harness()
  let drain!: () => void
  h.context.waitForIdle = () =>
    new Promise(resolve => {
      drain = resolve
    })
  const stopped: string[] = []
  h.rpc((method, id) => {
    if (method === 'stop') stopped.push(id)
    return {
      success: true,
      data: { details: { lifecycleStatus: { processTerminal: { version: 1, runId: id, state: 'observed' } } } }
    }
  })
  const cancellation = h.cancel()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(!h.messages.some(message => message.type === 'cancelled'))
  h.start('late-launch')
  drain()
  await cancellation
  assert.deepEqual(stopped, ['late-launch'])
  assert.deepEqual(h.messages.at(-1), { version: 1, type: 'cancelled' })
})

test('failed stop or unknown process proof reports cancellation failure', async () => {
  for (const failStop of [true, false]) {
    const h = harness()
    h.start('one')
    h.rpc((method, id) =>
      failStop && method === 'stop'
        ? { success: false, error: { message: 'denied' } }
        : {
            success: true,
            data: { details: { lifecycleStatus: { processTerminal: { version: 1, runId: id, state: 'unknown' } } } }
          }
    )
    await h.cancel()
    const result = h.messages.at(-1)
    assert.ok(result?.type === 'cancelled' && result.error)
    assert.match(result.error, failStop ? /denied/ : /unknown/)
  }
})

test('parent abort failures still drain background jobs and report cancellation failure', async () => {
  for (const abort of [
    () => {
      throw new Error('parent abort failed')
    },
    () => Promise.reject(new Error('parent abort failed'))
  ]) {
    const h = harness()
    h.context.abort = abort
    h.start('one')
    const stopped: string[] = []
    h.rpc((method, id) => {
      if (method === 'stop') stopped.push(id)
      return {
        success: true,
        data: { details: { lifecycleStatus: { processTerminal: { version: 1, runId: id, state: 'observed' } } } }
      }
    })
    await h.cancel()
    assert.deepEqual(stopped, ['one'])
    const result = h.messages.at(-1)
    assert.ok(result?.type === 'cancelled' && result.error?.includes('parent abort failed'))
  }
})

test('cancellation includes jobs registered while stopping and delivered jobs without proof', async () => {
  const h = harness()
  const stopped: string[] = []
  h.start('one')
  h.complete('one')
  h.rpc((method, id) => {
    if (method === 'stop') {
      stopped.push(id)
    }
    if (id === 'one' && method === 'status') h.start('two')
    return {
      success: true,
      data: { details: { lifecycleStatus: { processTerminal: { version: 1, runId: id, state: 'observed' } } } }
    }
  })
  await h.cancel()
  assert.deepEqual(stopped, ['two'])
})

test('workflow cancellation waits for completion delivery and validates descendant process incarnation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-acp-workflow-'))
  try {
    const flow = join(root, 'flow')
    const child = join(root, 'child')
    await Promise.all([mkdir(flow), mkdir(child)])
    await Promise.all([
      writeFile(
        join(flow, 'status.json'),
        JSON.stringify({
          runId: 'flow',
          sessionId: '/session.jsonl',
          mode: 'workflow',
          state: 'stopped',
          steps: [{ async: true, runId: 'child' }]
        })
      ),
      writeFile(
        join(child, 'status.json'),
        JSON.stringify({
          runId: 'child',
          sessionId: '/session.jsonl',
          processTerminal: { runnerProcessInstanceId: 'instance-1' }
        })
      ),
      writeFile(
        join(child, 'process-terminal.json'),
        JSON.stringify({ version: 1, runId: 'child', runnerProcessInstanceId: 'instance-1', state: 'observed' })
      )
    ])
    const h = harness()
    h.event('tool_result', {
      toolName: 'subagent',
      details: { asyncId: 'flow', runId: 'flow', mode: 'workflow', asyncDir: flow }
    })
    h.rpc(() => ({ success: true, data: { state: 'stopping' } }))
    const cancellation = h.cancel()
    await new Promise(resolve => setImmediate(resolve))
    assert.ok(!h.messages.some(message => message.type === 'cancelled'))
    h.complete('flow')
    await cancellation
    assert.deepEqual(h.messages.at(-1), { version: 1, type: 'cancelled' })

    await writeFile(
      join(child, 'process-terminal.json'),
      JSON.stringify({ version: 1, runId: 'child', runnerProcessInstanceId: 'different-instance', state: 'observed' })
    )
    const invalid = harness()
    invalid.event('tool_result', {
      toolName: 'subagent',
      details: { asyncId: 'flow', runId: 'flow', mode: 'workflow', asyncDir: flow }
    })
    invalid.complete('flow')
    invalid.rpc(() => ({ success: true, data: {} }))
    await invalid.cancel()
    const failed = invalid.messages.at(-1)
    assert.ok(failed?.type === 'cancelled' && failed.error?.includes('identity'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

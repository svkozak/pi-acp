import test from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

class FakeStore {
  get(_sessionId: string) {
    return { sessionId: 's1', cwd: '/tmp/project', sessionFile: '/tmp/s.jsonl', updatedAt: new Date().toISOString() }
  }
  upsert() {}
}

test('PiAcpAgent: loadSession replays toolResult as tool_call + tool_call_update', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'bash',
            args: { command: 'echo hello' },
            content: [{ type: 'text', text: 'hello from bash' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_1')
    assert.equal(toolCall.title, 'echo hello')
    assert.equal(toolCall.kind, 'execute')
    assert.deepEqual(toolCall.content, [{ type: 'terminal', terminalId: 'call_1' }])
    assert.deepEqual(toolCall._meta, { terminal_info: { terminal_id: 'call_1', cwd: '/tmp/project' } })
    assert.deepEqual(toolCall.rawInput, { command: 'echo hello' })
    assert.equal(toolCall.rawOutput, undefined)

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_1')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate.rawInput, { command: 'echo hello' })
    assert.deepEqual(toolCallUpdate.rawOutput, {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'echo hello' },
      content: [{ type: 'text', text: 'hello from bash' }],
      isError: false
    })
    assert.deepEqual(toolCallUpdate._meta, {
      terminal_output: { terminal_id: 'call_1', data: 'hello from bash' },
      terminal_exit: { terminal_id: 'call_1', exit_code: 0, signal: null }
    })
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: loadSession replays read toolResult with locations and plain title by default', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const previous = process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
  delete process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_2',
            toolName: 'read',
            args: { path: '/tmp/project/src/main.ts' },
            content: [{ type: 'text', text: 'export const x = 1' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_2')
    assert.equal(toolCall.title, 'read')
    assert.equal(toolCall.kind, 'read')
    assert.deepEqual(toolCall.rawInput, { path: '/tmp/project/src/main.ts' })
    assert.deepEqual(toolCall.locations, [{ path: '/tmp/project/src/main.ts' }])
    assert.deepEqual(toolCall.rawOutput, {
      role: 'toolResult',
      toolCallId: 'call_2',
      toolName: 'read',
      args: { path: '/tmp/project/src/main.ts' },
      content: [{ type: 'text', text: 'export const x = 1' }],
      isError: false
    })

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_2')
    assert.equal(toolCallUpdate.status, 'completed')
    assert.deepEqual(toolCallUpdate.content, [
      { type: 'content', content: { type: 'text', text: 'export const x = 1' } }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (previous === undefined) delete process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
    else process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES = previous
  }
})

test('PiAcpAgent: loadSession replays read toolResult with locations and descriptive title when enabled', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const previous = process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
  process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES = 'true'
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_3',
            toolName: 'read',
            args: { path: '/tmp/project/src/main.ts' },
            content: [{ type: 'text', text: 'export const x = 1' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const toolCall = updates.find(u => u?.sessionUpdate === 'tool_call')
    assert.ok(toolCall)
    assert.equal(toolCall.toolCallId, 'call_3')
    assert.equal(toolCall.title, 'Read src/main.ts')
    assert.equal(toolCall.kind, 'read')
    assert.deepEqual(toolCall.rawInput, { path: '/tmp/project/src/main.ts' })
    assert.deepEqual(toolCall.locations, [{ path: '/tmp/project/src/main.ts' }])

    const toolCallUpdate = updates.find(u => u?.sessionUpdate === 'tool_call_update')
    assert.ok(toolCallUpdate)
    assert.equal(toolCallUpdate.toolCallId, 'call_3')
    assert.equal(toolCallUpdate.status, 'completed')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (previous === undefined) delete process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
    else process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES = previous
  }
})

test('PiAcpAgent: loadSession recovers tool args from the assistant toolCall block', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const previousTitles = process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
  delete process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Running checks' },
              { type: 'toolCall', id: 'call_b', name: 'bash', arguments: { command: 'rg foo src/' } },
              { type: 'toolCall', id: 'call_r', name: 'read', arguments: { path: '/tmp/project/src/a.ts' } }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_b',
            toolName: 'bash',
            content: [{ type: 'text', text: 'src/a.ts:1:foo' }],
            isError: false
          },
          {
            role: 'toolResult',
            toolCallId: 'call_r',
            toolName: 'read',
            content: [{ type: 'text', text: 'file contents' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)

    const bashCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u?.toolCallId === 'call_b')
    assert.ok(bashCall)
    assert.equal(bashCall.title, 'rg foo src/')
    assert.deepEqual(bashCall.rawInput, { command: 'rg foo src/' })

    const readCall = updates.find(u => u?.sessionUpdate === 'tool_call' && u?.toolCallId === 'call_r')
    assert.ok(readCall)
    assert.equal(readCall.title, 'read')
    assert.deepEqual(readCall.rawInput, { path: '/tmp/project/src/a.ts' })
    assert.deepEqual(readCall.locations, [{ path: '/tmp/project/src/a.ts' }])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (previousTitles === undefined) delete process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
    else process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES = previousTitles
  }
})

test('PiAcpAgent: loadSession replays edit toolResult as a structured diff from args', async () => {
  const originalSpawn = PiRpcProcess.spawn
  const previousTitles = process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
  delete process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call_e',
                name: 'edit',
                arguments: { path: '/tmp/project/src/a.ts', edits: [{ oldText: 'foo', newText: 'bar' }] }
              }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_e',
            toolName: 'edit',
            content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.ts.' }],
            details: { diff: '-foo\n+bar\n' },
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)
    const update = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u?.toolCallId === 'call_e')
    assert.ok(update)
    assert.deepEqual(update.content, [{ type: 'diff', path: '/tmp/project/src/a.ts', oldText: 'foo', newText: 'bar' }])
    assert.equal(update.rawOutput, undefined, 'rawOutput should be suppressed when a structured diff is emitted')
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (previousTitles === undefined) delete process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES
    else process.env.PI_ACP_ENABLE_DESCRIPTIVE_TOOL_TITLES = previousTitles
  }
})

test('PiAcpAgent: loadSession replays write toolResult as a new-file diff from args.content', async () => {
  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async () => {
    return {
      onEvent: () => () => {},
      getMessages: async () => ({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call_w',
                name: 'write',
                arguments: { path: '/tmp/project/new.ts', content: 'created\n' }
              }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call_w',
            toolName: 'write',
            content: [{ type: 'text', text: 'Successfully wrote 8 bytes to new.ts' }],
            isError: false
          }
        ]
      }),
      getAvailableModels: async () => ({ models: [] }),
      getState: async () => ({ thinkingLevel: 'medium' })
    } as any
  }

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    ;(agent as any).store = new FakeStore()

    await agent.loadSession({ sessionId: 's1', cwd: '/tmp/project', mcpServers: [] } as any)

    const updates = conn.updates.map(u => (u as any).update)
    const update = updates.find(u => u?.sessionUpdate === 'tool_call_update' && u?.toolCallId === 'call_w')
    assert.ok(update)
    assert.deepEqual(update.content, [
      { type: 'diff', path: '/tmp/project/new.ts', oldText: null, newText: 'created\n' }
    ])
    assert.equal(update.rawOutput, undefined, 'rawOutput should be suppressed when a structured diff is emitted')
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

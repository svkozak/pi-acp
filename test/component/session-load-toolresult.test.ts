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

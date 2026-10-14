import test, { afterEach, beforeEach, describe } from 'node:test'
import assert from 'node:assert/strict'

import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// This test mutates process.env.PI_ACP_BASH_MAX_OUTPUT_LINES. session.ts reads
// the env var from a deferred-microtask emit chain, so a concurrent test whose
// body sets the var can interleave with this one's deferred reads. Keeping it
// in its own process (each test file runs in a separate node:test process)
// avoids perturbing suites that assert the default streaming behavior.
describe('bash output truncation', { concurrency: 1 }, () => {
  beforeEach(() => {
    process.env.PI_ACP_BASH_MAX_OUTPUT_LINES = '2'
  })

  afterEach(() => {
    delete process.env.PI_ACP_BASH_MAX_OUTPUT_LINES
  })

  test('PiAcpSession: tail-truncates live bash terminal output', async () => {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()

    new PiAcpSession({
      sessionId: 's1',
      cwd: process.cwd(),
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: []
    })

    proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'seq 1 5' } })
    proc.emit({
      type: 'tool_execution_update',
      toolCallId: 't1',
      partialResult: { content: [{ type: 'text', text: '1\n2\n3\n' }] }
    })
    proc.emit({
      type: 'tool_execution_update',
      toolCallId: 't1',
      partialResult: { content: [{ type: 'text', text: '1\n2\n3\n4\n' }] }
    })
    proc.emit({
      type: 'tool_execution_end',
      toolCallId: 't1',
      isError: false,
      result: { content: [{ type: 'text', text: '1\n2\n3\n4\n5' }] }
    })

    await new Promise(r => setTimeout(r, 0))

    const intermediateUpdates = conn.updates.filter(
      u => u.update.sessionUpdate === 'tool_call_update' && (u.update as any).status === 'in_progress'
    )
    assert.equal(intermediateUpdates.length, 0, 'tail-truncate mode should not emit intermediate terminal_output')

    const completed = conn.updates.find(u => (u.update as any).status === 'completed')
    assert.ok(completed)
    assert.deepEqual((completed!.update as any)._meta.terminal_output, {
      terminal_id: 't1',
      data: '... (3 earlier lines truncated)\n4\n5'
    })
    assert.deepEqual((completed!.update as any).rawOutput, {
      content: [{ type: 'text', text: '1\n2\n3\n4\n5' }]
    })
  })
})

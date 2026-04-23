import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

// Helpers -------------------------------------------------------------

function setTimeoutFlush(): Promise<void> {
  // Allow the serialized lastEmit chain + scheduled emits to drain.
  return new Promise(resolve => setTimeout(resolve, 10))
}

function findUpdate(
  conn: FakeAgentSideConnection,
  match: (u: any) => boolean
) {
  for (let i = conn.updates.length - 1; i >= 0; i -= 1) {
    const u = (conn.updates[i] as any).update
    if (match(u)) return u
  }
  return undefined
}

// Tests ---------------------------------------------------------------

test('PiAcpSession: emits usage snapshot + status line on agent_end', async () => {
  const prevHide = process.env.PI_ACP_HIDE_USAGE_STATUS
  delete process.env.PI_ACP_HIDE_USAGE_STATUS

  try {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()

    const session = new PiAcpSession({
      sessionId: 's1',
      cwd: '/tmp/project',
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: [],
      contextWindow: 100_000,
      modelId: 'anthropic/claude-sonnet-4'
    })

    // Kick off a turn.
    const turn = session.prompt('hi')

    // Simulate pi events: agent_start → message_update (text) → message_end (usage) → agent_end.
    proc.emit({ type: 'agent_start' })
    proc.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        usage: {
          input: 1234,
          output: 567,
          cacheRead: 8500,
          cacheWrite: 200,
          totalTokens: 10501,
          cost: { input: 0.004, output: 0.008, cacheRead: 0.001, cacheWrite: 0.00025, total: 0.01325 }
        }
      }
    })
    proc.emit({ type: 'agent_end' })

    assert.equal(await turn, 'end_turn')
    await setTimeoutFlush()

    // Structured meta present.
    const info = findUpdate(conn, u => u?.sessionUpdate === 'session_info_update' && u?._meta?.piAcp?.usage)
    assert.ok(info, 'expected session_info_update with _meta.piAcp.usage')
    const usage = info._meta.piAcp.usage
    assert.equal(usage.sessionInputTokens, 1234)
    assert.equal(usage.sessionOutputTokens, 567)
    assert.equal(usage.sessionCost, 0.01325)
    assert.equal(usage.contextWindow, 100_000)
    assert.ok(usage.contextFillRatio !== null && usage.contextFillRatio > 0)

    // First-class ACP usage_update (the one that drives Zed's context ring).
    const ring = findUpdate(conn, u => u?.sessionUpdate === 'usage_update')
    assert.ok(ring, 'expected usage_update')
    assert.equal(ring.size, 100_000)
    // used = last prompt = input + cacheRead + cacheWrite
    assert.equal(ring.used, 1234 + 8500 + 200)
    assert.equal(ring.cost.currency, 'USD')
    assert.ok(Math.abs(ring.cost.amount - 0.01325) < 1e-9)

    // Status chunk present with human-readable summary.
    const chunk = findUpdate(
      conn,
      u => u?.sessionUpdate === 'agent_message_chunk' && typeof u?.content?.text === 'string' && u.content.text.includes('ctx')
    )
    assert.ok(chunk, 'expected a usage status chunk with ctx fill')
  } finally {
    if (prevHide === undefined) delete process.env.PI_ACP_HIDE_USAGE_STATUS
    else process.env.PI_ACP_HIDE_USAGE_STATUS = prevHide
  }
})

test('PiAcpSession: PI_ACP_HIDE_USAGE_STATUS=1 suppresses the status chunk but keeps the meta', async () => {
  process.env.PI_ACP_HIDE_USAGE_STATUS = '1'

  try {
    const conn = new FakeAgentSideConnection()
    const proc = new FakePiRpcProcess()

    const session = new PiAcpSession({
      sessionId: 's2',
      cwd: '/tmp/project',
      mcpServers: [],
      proc: proc as any,
      conn: asAgentConn(conn),
      fileCommands: [],
      contextWindow: null,
      modelId: null
    })

    const turn = session.prompt('hi')
    proc.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } }
      }
    })
    proc.emit({ type: 'agent_end' })
    assert.equal(await turn, 'end_turn')
    await setTimeoutFlush()

    // No status chunk emitted.
    const chunk = findUpdate(
      conn,
      u => u?.sessionUpdate === 'agent_message_chunk' && typeof u?.content?.text === 'string' && u.content.text.includes('ctx')
    )
    assert.equal(chunk, undefined)

    // But the meta is still there.
    const info = findUpdate(conn, u => u?.sessionUpdate === 'session_info_update' && u?._meta?.piAcp?.usage)
    assert.ok(info)
  } finally {
    delete process.env.PI_ACP_HIDE_USAGE_STATUS
  }
})

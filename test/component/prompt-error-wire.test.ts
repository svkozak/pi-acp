import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession, SessionManager } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess } from '../helpers/fakes.js'

function setup(t: TestContext, proc = new FakePiRpcProcess()) {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      t.after(() => controller.terminate())
    }
  })
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      t.after(() => controller.terminate())
    }
  })
  const observer = new FakeAgentSideConnection()
  const client = new ClientSideConnection(() => observer, ndJsonStream(clientToAgent.writable, agentToClient.readable))
  new AgentSideConnection(
    conn => {
      const session = new PiAcpSession({
        sessionId: 'errors',
        cwd: process.cwd(),
        mcpServers: [],
        proc: proc as unknown as PiRpcProcess,
        conn
      })
      t.after(() => session.dispose())
      t.mock.method(SessionManager.prototype, 'maybeGet', () => session)
      return new PiAcpAgent(conn)
    },
    ndJsonStream(agentToClient.writable, clientToAgent.readable)
  )

  const prompt = (text: string) => client.prompt({ sessionId: 'errors', prompt: [{ type: 'text', text }] })
  const texts = () =>
    observer.updates.flatMap(({ update }) =>
      update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? [update.content.text] : []
    )
  return { proc, prompt, texts }
}

test('ACP serializes provider failure after partial output and allows the next prompt', { timeout: 3000 }, async t => {
  const { proc, prompt, texts } = setup(t)
  t.mock.method(proc, 'prompt', async () => {
    proc.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Partial answer' } })
    proc.emit({
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '429: {"message":"Monthly usage limit reached"}'
      }
    })
    proc.emit({ type: 'agent_settled' })
  })

  await assert.rejects(prompt('one'), {
    code: -32603,
    message: 'Internal error: 429: Monthly usage limit reached'
  })
  assert.deepEqual(texts(), ['Partial answer'])

  t.mock.method(proc, 'prompt', async () => {
    proc.emit({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop' } })
    proc.emit({ type: 'agent_settled' })
  })
  assert.deepEqual(await prompt('two'), { stopReason: 'end_turn' })
})

test('ACP serializes a manual command failure with its reason', { timeout: 3000 }, async t => {
  const proc = Object.assign(new FakePiRpcProcess(), {
    async compact() {
      throw new Error('Compaction service unavailable')
    }
  })
  const { prompt, texts } = setup(t, proc)

  await assert.rejects(prompt('/compact'), {
    code: -32603,
    message: 'Internal error: Compaction service unavailable'
  })
  assert.deepEqual(texts(), [])
})

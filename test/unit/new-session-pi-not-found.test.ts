import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: newSession returns a helpful Internal error when pi is not installed', async () => {
  const prevPiCmd = process.env.PI_ACP_PI_COMMAND
  process.env.PI_ACP_PI_COMMAND = 'pi-does-not-exist-12345'

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) => e?.code === -32603 && String(e?.message ?? '').toLowerCase().includes('executable not found')
    )
  } finally {
    if (prevPiCmd == null) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = prevPiCmd
  }
})

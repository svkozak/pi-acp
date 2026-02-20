import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: newSession returns a helpful Internal error when pi is not installed', async () => {
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR
  const prevPiCmd = process.env.PI_ACP_PI_COMMAND

  // Ensure we pass the auth gate so the agent actually tries to spawn pi.
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-pi-not-found-'))
  writeFileSync(join(dir, 'auth.json'), '{"dummy":"x"}', 'utf-8')
  writeFileSync(join(dir, 'models.json'), '{}', 'utf-8')

  process.env.PI_CODING_AGENT_DIR = dir
  process.env.PI_ACP_PI_COMMAND = 'pi-does-not-exist-12345'

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) => e?.code === -32603 && String(e?.message ?? '').toLowerCase().includes('executable not found')
    )
  } finally {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir

    if (prevPiCmd == null) delete process.env.PI_ACP_PI_COMMAND
    else process.env.PI_ACP_PI_COMMAND = prevPiCmd
  }
})

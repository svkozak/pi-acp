import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

for (const mode of ['load', 'auto-restore', 'long-session'] as const) {
  test(`PiAcpAgent: ${mode} uses the saved first-message fallback without renaming the session`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-title-'))
    const cwd = join(root, 'project')
    const agentDir = join(root, 'agent')
    const sessionsDir = join(agentDir, 'sessions')
    const sessionFile = join(sessionsDir, 'history.jsonl')
    mkdirSync(cwd)
    mkdirSync(sessionsDir, { recursive: true })
    const entries = [
      { type: 'session', id: 'history', version: 3, cwd },
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '  Original\n task 😀  ' }] } },
      ...Array.from({ length: mode === 'long-session' ? 2100 : 1 }, () => ({
        type: 'message',
        message: { role: 'assistant', content: 'Later reply' }
      }))
    ]
    const evidence = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n'
    writeFileSync(sessionFile, evidence)
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = agentDir

    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    Object.assign(agent, { store: new SessionStore(join(root, 'session-map.json')) })
    const proc = new FakePiRpcProcess()
    // The active RPC history may have been compacted; it is not a reliable title source on restore.
    proc.getMessages = async () => ({ messages: [{ role: 'user', content: 'Recent context only' }] })
    t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)

    try {
      const listed = await agent.listSessions({ cwd })
      assert.equal(listed.sessions[0]?.title, 'Original task 😀')

      if (mode === 'auto-restore') {
        proc.prompt = async () => {
          proc.emit({ type: 'message_start', message: { role: 'user', content: 'Continue from today' } })
          proc.emit({ type: 'agent_settled' })
        }
        const result = await agent.prompt({
          sessionId: 'history',
          prompt: [{ type: 'text', text: 'Continue from today' }]
        })
        assert.equal(result.stopReason, 'end_turn')
      } else {
        await agent.loadSession({ sessionId: 'history', cwd, mcpServers: [] })
      }

      const titles = conn.updates.flatMap(({ update }) =>
        update.sessionUpdate === 'session_info_update' && typeof update.title === 'string' ? [update.title] : []
      )
      assert.deepEqual(titles, ['Original task 😀'])
      assert.equal(readFileSync(sessionFile, 'utf8'), evidence)
    } finally {
      agent.dispose()
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      rmSync(root, { recursive: true, force: true })
    }
  })
}

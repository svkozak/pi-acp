import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  async create(_params: any) {
    return this.session
  }
  closeAllExcept() {}
}

test('PiAcpAgent: startup info includes project-level packages from .pi/settings.json', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  // Create a fake global agent dir (empty settings)
  const agentDir = mkdtempSync(join(tmpdir(), 'pi-acp-global-'))
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: ['npm:global-ext'] }), 'utf-8')
  process.env.PI_CODING_AGENT_DIR = agentDir

  // Create a fake project dir with .pi/settings.json containing packages
  const projectDir = mkdtempSync(join(tmpdir(), 'pi-acp-project-'))
  const piDir = join(projectDir, '.pi')
  mkdirSync(piDir)
  writeFileSync(join(piDir, 'settings.json'), JSON.stringify({ packages: ['/path/to/local-extension'] }), 'utf-8')

  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = (fn: unknown) => {
    return 0 as any
  }

  try {
    const conn = new FakeAgentSideConnection()

    const session = {
      sessionId: 's1',
      cwd: projectDir,
      proc: {
        async getAvailableModels() {
          return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
        },
        async getState() {
          return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
        },
        async getCommands() {
          return { commands: [] }
        }
      },
      setStartupInfo(_text: string) {},
      sendStartupInfoIfPending() {}
    }

    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any

    const res = await agent.newSession({ cwd: projectDir, mcpServers: [] } as any)
    const startupInfo: string = res?._meta?.piAcp?.startupInfo ?? ''

    assert.ok(startupInfo.includes('npm:global-ext'), 'should include global package')
    assert.ok(startupInfo.includes('/path/to/local-extension'), 'should include project package')
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

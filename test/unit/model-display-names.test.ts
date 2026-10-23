import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  maybeGet(sessionId: string) {
    return sessionId === this.session.sessionId ? this.session : undefined
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) throw new Error(`Unknown sessionId: ${sessionId}`)
    return this.session
  }
}

async function advertisedModels(models: any[], current: { provider: string; id: string }) {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any
  try {
    const conn = new FakeAgentSideConnection()
    const session = {
      sessionId: 's1',
      cwd: process.cwd(),
      proc: {
        async getAvailableThinkingLevels() {
          return ['off', 'low', 'medium', 'high']
        },
        async getAvailableModels() {
          return { models }
        },
        async getState() {
          return { thinkingLevel: 'medium', model: current }
        }
      },
      setStartupInfo() {},
      sendStartupInfoIfPending() {}
    }
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(session) as any
    const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any)
    const option = result.configOptions?.find(o => o.id === 'model') as any
    return { models: result.models!, options: option.options as { value: string; name: string }[] }
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
}

// Some ACP clients (JetBrains IDEs) reject the whole model selector when any item's
// display name is blank or identical to its value, or when the current model is not listed.
test('model display names never equal their ids', async () => {
  const { options } = await advertisedModels(
    [
      { provider: 'centralgui', id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
      { provider: 'centralgui', id: 'no-name' },
      { provider: 'centralgui', id: 'blank-name', name: '   ' },
      { provider: 'anthropic', id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' }
    ],
    { provider: 'anthropic', id: 'claude-sonnet-5-5' }
  )

  assert.deepEqual(options, [
    { value: 'centralgui/deepseek-v4.1-flash', name: 'deepseek-v4.1-flash (centralgui)', description: null },
    { value: 'centralgui/no-name', name: 'no-name (centralgui)', description: null },
    { value: 'centralgui/blank-name', name: 'blank-name (centralgui)', description: null },
    { value: 'anthropic/claude-sonnet-5-5', name: 'anthropic/Claude Sonnet 5.5', description: null }
  ])
  for (const o of options) {
    assert.notEqual(o.name.trim(), '')
    assert.notEqual(o.name, o.value)
  }
})

test('current model is always among the advertised models', async () => {
  const { models, options } = await advertisedModels([{ provider: 'test', id: 'alpha', name: 'Alpha' }], {
    provider: 'router',
    id: 'auto'
  })

  assert.equal(models.currentModelId, 'router/auto')
  assert.deepEqual(
    options.map(o => o.value),
    ['test/alpha', 'router/auto']
  )
  assert.ok(options.every(o => o.name !== o.value))
})

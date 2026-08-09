import assert from 'node:assert/strict'
import test from 'node:test'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: newSession finishes the command probe before exposing the session', async () => {
  let releaseCommands: (() => void) | undefined
  let resolved = false
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'model', name: 'Model' }] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
      },
      async getCommands() {
        await new Promise<void>(resolve => {
          releaseCommands = resolve
        })
        return { commands: [] }
      }
    },
    setStartupInfo() {},
    sendStartupInfoIfPending() {}
  }
  const sessions = {
    async create() {
      return session
    },
    closeAllExcept() {}
  }
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  ;(agent as any).sessions = sessions

  const creating = agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any).then(result => {
    resolved = true
    return result
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(resolved, false)

  releaseCommands?.()
  const result = await creating
  assert.equal(result.sessionId, 's1')
})

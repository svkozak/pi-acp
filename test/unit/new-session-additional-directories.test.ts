import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  createCalls: any[] = []

  constructor(private readonly session: any) {}

  async create(params: any) {
    this.createCalls.push(params)
    return this.session
  }

  maybeGet(sessionId: string) {
    if (sessionId !== this.session.sessionId) return undefined
    return this.session
  }

  get(sessionId: string) {
    if (sessionId !== this.session.sessionId) {
      throw new Error(`Unknown sessionId: ${sessionId}`)
    }
    return this.session
  }
}

function makeSession(cwd: string) {
  return {
    sessionId: 's1',
    cwd,
    setStartupInfo() {},
    sendStartupInfoIfPending() {},
    proc: {
      async getAvailableModels() {
        return { models: [{ provider: 'test', id: 'alpha', name: 'Alpha' }] }
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }
}

test('PiAcpAgent: newSession forwards normalized additionalDirectories to the session', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const cwd = process.cwd()
    const extra = resolve(cwd, 'lib')

    const session = makeSession(cwd)
    const sessions = new FakeSessions(session)
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any

    await agent.newSession({ cwd, mcpServers: [], additionalDirectories: [extra, extra, cwd] } as any)

    assert.equal(sessions.createCalls.length, 1)
    assert.deepEqual(sessions.createCalls[0].additionalDirectories, [extra])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: newSession accepts omitted additionalDirectories', async () => {
  const realSetTimeout = globalThis.setTimeout
  ;(globalThis as any).setTimeout = () => 0 as any

  try {
    const conn = new FakeAgentSideConnection()
    const cwd = process.cwd()

    const session = makeSession(cwd)
    const sessions = new FakeSessions(session)
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any

    await agent.newSession({ cwd, mcpServers: [] } as any)

    assert.equal(sessions.createCalls.length, 1)
    assert.deepEqual(sessions.createCalls[0].additionalDirectories, [])
  } finally {
    ;(globalThis as any).setTimeout = realSetTimeout
  }
})

test('PiAcpAgent: newSession rejects relative additionalDirectories', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [], additionalDirectories: ['relative/path'] } as any),
    (e: any) => e?.code === -32602
  )
})

test('PiAcpAgent: initialize advertises sessionCapabilities.additionalDirectories', async () => {
  const conn = new FakeAgentSideConnection()
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)

  const res = await agent.initialize({ protocolVersion: 1 } as any)

  assert.deepEqual((res as any).agentCapabilities.sessionCapabilities.additionalDirectories, {})
})

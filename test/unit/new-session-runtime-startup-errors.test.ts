import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  closeCalls: string[] = []

  constructor(private readonly session: any) {}

  async create() {
    return this.session
  }

  close(sessionId: string) {
    this.closeCalls.push(sessionId)
  }
}

test('PiAcpAgent: newSession returns AUTH_REQUIRED when pi reports an auth error after spawn', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-runtime-auth-'))
  const sessionFile = join(root, 'sessions', 'failed.jsonl')
  const sessionMapPath = join(root, 'session-map.json')

  mkdirSync(join(root, 'sessions'), { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 's-auth',
      timestamp: '2026-05-07T00:00:00.000Z',
      cwd: process.cwd()
    }) + '\n',
    'utf-8'
  )

  const session = {
    sessionId: 's-auth',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        throw new Error('Authentication required: missing key')
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null, sessionFile }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const store = new SessionStore(sessionMapPath)
  store.upsert({ sessionId: 's-auth', cwd: process.cwd(), sessionFile })
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = sessions as any
  ;(agent as any).store = store as any

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => e?.code === -32000
  )

  assert.deepEqual(sessions.closeCalls, ['s-auth'])
  assert.equal(existsSync(sessionFile), false)
  assert.equal(store.get('s-auth'), null)
})

test('PiAcpAgent: newSession returns Internal error on non-auth model probe failures after spawn', async () => {
  const conn = new FakeAgentSideConnection()

  const session = {
    sessionId: 's-internal',
    cwd: process.cwd(),
    proc: {
      async getAvailableModels() {
        throw new Error('socket hang up')
      },
      async getState() {
        return { thinkingLevel: 'medium', model: null }
      }
    }
  }

  const sessions = new FakeSessions(session)
  const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
  ;(agent as any).sessions = sessions as any

  await assert.rejects(
    () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
    (e: any) => e?.code === -32603 && String(e?.message ?? '').includes('socket hang up')
  )

  assert.deepEqual(sessions.closeCalls, ['s-internal'])
})

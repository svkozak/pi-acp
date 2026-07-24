import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  readonly closed: string[] = []

  constructor(
    private readonly buildSession: (sessionId: string, params: any) => any,
    private restoredSession: any = null
  ) {}

  maybeGet(sessionId: string) {
    return this.restoredSession?.sessionId === sessionId ? this.restoredSession : undefined
  }

  close(sessionId: string) {
    this.closed.push(sessionId)
    if (this.restoredSession?.sessionId === sessionId) this.restoredSession = null
  }

  getOrCreate(sessionId: string, params: any) {
    if (!this.restoredSession) {
      this.restoredSession = this.buildSession(sessionId, params)
    }
    return this.restoredSession
  }
}

test('PiAcpAgent: prompt auto-restores a missing session from SessionStore', async () => {
  const conn = new FakeAgentSideConnection()
  const promptCalls: Array<{ message: string; images: unknown[] }> = []
  const spawnCalls: any[] = []
  const storeUpserts: any[] = []

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc,
    async prompt(message: string, images: unknown[]) {
      promptCalls.push({ message, images })
      return 'end_turn'
    },
    async cancel() {},
    wasCancelRequested() {
      return false
    }
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get(sessionId: string) {
        if (sessionId !== 'stored-session') return null
        return {
          sessionId,
          cwd: '/tmp/store-project',
          sessionFile: '/tmp/store-project/session.jsonl',
          updatedAt: new Date().toISOString()
        }
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.prompt({
      sessionId: 'stored-session',
      prompt: [{ type: 'text', text: 'hello again' }]
    } as any)

    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/store-project',
        sessionPath: '/tmp/store-project/session.jsonl',
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.deepEqual(promptCalls, [{ message: 'hello again', images: [] }])
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'stored-session',
        cwd: '/tmp/store-project',
        sessionFile: '/tmp/store-project/session.jsonl'
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: prompt evicts a session whose pi child died and respawns from SessionStore', async () => {
  const conn = new FakeAgentSideConnection()
  const promptCalls: Array<{ message: string; images: unknown[] }> = []
  const spawnCalls: any[] = []

  const deadSession = {
    sessionId: 'stored-session',
    proc: { isAlive: () => false },
    prompt() {
      throw new Error('dead session must not be prompted')
    }
  }

  const sessions = new FakeSessions(
    (sessionId, params) => ({
      sessionId,
      cwd: params.cwd,
      proc: params.proc,
      async prompt(message: string, images: unknown[]) {
        promptCalls.push({ message, images })
        return 'end_turn'
      }
    }),
    deadSession
  )

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return { onEvent: () => () => {}, isAlive: () => true } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get(sessionId: string) {
        if (sessionId !== 'stored-session') return null
        return { sessionId, cwd: '/tmp/store-project', sessionFile: '/tmp/store-project/session.jsonl' }
      },
      upsert() {}
    }

    const result = await agent.prompt({
      sessionId: 'stored-session',
      prompt: [{ type: 'text', text: 'still there?' }]
    } as any)

    assert.equal(result.stopReason, 'end_turn')
    assert.deepEqual(sessions.closed, ['stored-session'])
    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/store-project',
        sessionPath: '/tmp/store-project/session.jsonl',
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.deepEqual(promptCalls, [{ message: 'still there?', images: [] }])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: prompt surfaces a JSON-RPC error when the pi child dies after the isAlive check', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []

  // isAlive() still reports true when restoreSession checks it, but the child is
  // already gone, so the stdin write rejects with EPIPE.
  const racyProc = {
    isAlive: () => true,
    onEvent: () => () => {},
    prompt: () => Promise.reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
  }

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return { onEvent: () => () => {} } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    // Real PiAcpSession (not FakeSessions) so the rejection flows through startTurn.
    ;(agent as any).sessions.getOrCreate('stored-session', {
      cwd: '/tmp/store-project',
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: racyProc as any,
      fileCommands: []
    })

    await assert.rejects(
      agent.prompt({
        sessionId: 'stored-session',
        prompt: [{ type: 'text', text: 'still there?' }]
      } as any),
      (e: any) => e instanceof RequestError && e.code === -32603
    )

    assert.deepEqual(spawnCalls, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

test('PiAcpAgent: setSessionConfigOption auto-restores via pi session discovery when SessionStore misses', async () => {
  const conn = new FakeAgentSideConnection()
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-restore-fallback-'))
  const sessionsDir = join(root, 'sessions', '--tmp--fallback-project--')
  const sessionFile = join(sessionsDir, '0000_restore_fallback.jsonl')
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR

  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(
    sessionFile,
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'fallback-session',
      timestamp: '2026-06-16T00:00:00.000Z',
      cwd: '/tmp/fallback-project'
    }) + '\n',
    'utf-8'
  )

  process.env.PI_CODING_AGENT_DIR = root

  const storeUpserts: any[] = []
  const setModelCalls: Array<{ provider: string; modelId: string }> = []
  const spawnCalls: any[] = []
  const state = {
    thinkingLevel: 'medium',
    model: { provider: 'test', id: 'alpha' }
  }

  const sessions = new FakeSessions((sessionId, params) => ({
    sessionId,
    cwd: params.cwd,
    proc: params.proc
  }))

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {},
      getAvailableModels: async () => ({
        models: [
          { provider: 'test', id: 'alpha', name: 'Alpha' },
          { provider: 'test', id: 'beta', name: 'Beta' }
        ]
      }),
      getState: async () => state,
      async setModel(provider: string, modelId: string) {
        setModelCalls.push({ provider, modelId })
        state.model = { provider, id: modelId }
      }
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = sessions as any
    ;(agent as any).store = {
      get() {
        return null
      },
      upsert(entry: any) {
        storeUpserts.push(entry)
      }
    }

    const result = await agent.setSessionConfigOption({
      sessionId: 'fallback-session',
      configId: 'model',
      value: 'test/beta'
    } as any)

    assert.deepEqual(spawnCalls, [
      {
        cwd: '/tmp/fallback-project',
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.deepEqual(setModelCalls, [{ provider: 'test', modelId: 'beta' }])
    assert.equal(result.configOptions.find(option => option.id === 'model')?.currentValue, 'test/beta')
    assert.deepEqual(storeUpserts, [
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      },
      {
        sessionId: 'fallback-session',
        cwd: '/tmp/fallback-project',
        sessionFile
      }
    ])
    assert.deepEqual(conn.updates, [
      {
        sessionId: 'fallback-session',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: result.configOptions
        }
      }
    ])
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir
  }
})

test('PiAcpAgent: cancel ignores stale session IDs without spawning a restore process', async () => {
  const conn = new FakeAgentSideConnection()
  const spawnCalls: any[] = []

  const originalSpawn = PiRpcProcess.spawn
  ;(PiRpcProcess as any).spawn = async (params: any) => {
    spawnCalls.push(params)
    return {
      onEvent: () => () => {}
    } as any
  }

  try {
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FakeSessions(() => {
      throw new Error('cancel should not restore a missing session')
    }) as any

    await agent.cancel({ sessionId: 'stale-session' } as any)

    assert.deepEqual(spawnCalls, [])
    assert.deepEqual(conn.updates, [])
  } finally {
    PiRpcProcess.spawn = originalSpawn
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../../src/acp/session.js'
import { SessionStore } from '../../src/acp/session-store.js'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function fixture() {
  const conn = new FakeAgentSideConnection()
  const state = { thinkingLevel: 'max', model: { provider: 'test', id: 'reasoning' } }
  const calls: string[] = []
  const proc = {
    onEvent: () => () => {},
    getMessages: async () => ({ messages: [] }),
    getState: async () => state,
    getAvailableModels: async () => ({
      models: [
        { provider: 'test', id: 'reasoning' },
        { provider: 'test', id: 'plain' }
      ]
    }),
    getAvailableThinkingLevels: async () => (state.model.id === 'plain' ? ['off'] : ['low', 'high', 'max']),
    async setThinkingLevel(level: string) {
      calls.push(level)
      state.thinkingLevel = 'max'
    },
    async setModel(provider: string, id: string) {
      calls.push(id)
      state.model = { provider, id }
      state.thinkingLevel = id === 'plain' ? 'off' : 'max'
    }
  }
  const session = {
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    setStartupInfo() {},
    sendStartupInfoIfPending() {},
    async publishContextUsage() {}
  }
  const agent = new PiAcpAgent(asAgentConn(conn))
  Reflect.set(agent, 'sessions', {
    maybeGet: () => session,
    get: () => session,
    create: async () => session,
    close() {}
  })
  return { agent, conn, proc, state, calls }
}

function assertUpdates(conn: FakeAgentSideConnection, level: string, levels: string[]) {
  assert.equal(conn.updates.length, 2)
  assert.deepEqual(conn.updates[0], {
    sessionId: 's1',
    update: { sessionUpdate: 'current_mode_update', currentModeId: level }
  })
  const update = conn.updates[1].update as {
    configOptions: Array<{ id: string; currentValue: string; options: Array<{ value: string }> }>
  }
  const option = update.configOptions.find(option => option.id === 'thought_level')!
  assert.equal(option.currentValue, level)
  assert.deepEqual(
    option.options.map(option => option.value),
    levels
  )
}

for (const legacy of [false, true]) {
  for (const requested of ['max', 'xhigh', 'ordinary', ' mean ', ' ']) {
    test(`${legacy ? 'legacy' : 'config'} reasoning setter reports actual max for ${requested}`, async () => {
      const { agent, conn, calls } = fixture()
      if (legacy) await agent.setSessionMode({ sessionId: 's1', modeId: requested })
      else {
        const result = await agent.setSessionConfigOption({
          sessionId: 's1',
          configId: 'thought_level',
          value: requested
        })
        assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'max')
      }
      assert.deepEqual(calls, [requested])
      assertUpdates(conn, 'max', ['low', 'high', 'max'])
    })
  }
  test(`${legacy ? 'legacy' : 'config'} reasoning setter reports an opaque applied level`, async () => {
    const { agent, conn, proc, state, calls } = fixture()
    proc.getAvailableThinkingLevels = async () => ['ordinary', 'mean']
    proc.setThinkingLevel = async level => {
      calls.push(level)
      state.thinkingLevel = 'mean'
    }
    if (legacy) await agent.setSessionMode({ sessionId: 's1', modeId: 'ordinary' })
    else {
      const result = await agent.setSessionConfigOption({
        sessionId: 's1',
        configId: 'thought_level',
        value: 'ordinary'
      })
      assert.equal(result.configOptions.find(option => option.id === 'thought_level')?.currentValue, 'mean')
    }
    assert.deepEqual(calls, ['ordinary'])
    assertUpdates(conn, 'mean', ['ordinary', 'mean'])
  })
  test(`${legacy ? 'legacy' : 'config'} model setter refreshes model-specific levels and current mode`, async () => {
    const { agent, conn } = fixture()
    for (const model of ['plain', 'reasoning']) {
      conn.updates.length = 0
      if (legacy) await agent.unstable_setSessionModel({ sessionId: 's1', modelId: `test/${model}` })
      else await agent.setSessionConfigOption({ sessionId: 's1', configId: 'model', value: `test/${model}` })
      assertUpdates(conn, model === 'plain' ? 'off' : 'max', model === 'plain' ? ['off'] : ['low', 'high', 'max'])
    }
  })
  for (const failure of ['state', 'discovery', 'empty', 'non-string', 'inconsistent']) {
    test(`${legacy ? 'legacy' : 'config'} reasoning setter emits no success on ${failure} read failure`, async () => {
      const { agent, conn, proc, state } = fixture()
      if (failure === 'state')
        proc.getState = async () => {
          throw new Error('state failed')
        }
      if (failure === 'discovery')
        proc.getAvailableThinkingLevels = async () => {
          throw new Error('discovery failed')
        }
      if (failure === 'empty' || failure === 'non-string' || failure === 'inconsistent')
        proc.setThinkingLevel = async () => {
          Reflect.set(state, 'thinkingLevel', failure === 'empty' ? '' : failure === 'non-string' ? 1 : 'medium')
        }
      await assert.rejects(
        legacy
          ? agent.setSessionMode({ sessionId: 's1', modeId: 'max' })
          : agent.setSessionConfigOption({ sessionId: 's1', configId: 'thought_level', value: 'max' })
      )
      assert.deepEqual(conn.updates, [])
    })
  }
}

test('invalid configuration and legacy mode requests do not mutate Pi', async () => {
  const { agent, calls, conn } = fixture()
  for (const request of [
    { configId: 'thought_level', value: '' },
    { configId: 'unknown', value: 'high' },
    { configId: 'thought_level', value: 1 }
  ]) {
    await assert.rejects(
      agent.setSessionConfigOption({ sessionId: 's1', ...request } as Parameters<
        PiAcpAgent['setSessionConfigOption']
      >[0]),
      { code: -32602 }
    )
  }
  for (const modeId of ['', 1, null]) {
    await assert.rejects(
      agent.setSessionMode({ sessionId: 's1', modeId } as Parameters<PiAcpAgent['setSessionMode']>[0]),
      { code: -32602 }
    )
  }
  assert.deepEqual(calls, [])
  assert.deepEqual(conn.updates, [])
})

for (const load of [false, true]) {
  for (const levels of [['off'], ['low', 'high', 'max'], ['ordinary', 'mean']]) {
    test(`${load ? 'load' : 'new'} session advertises exact ${levels} levels`, async t => {
      const { agent, proc, state } = fixture()
      state.thinkingLevel = levels[levels.length - 1]
      proc.getAvailableThinkingLevels = async () => levels
      t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
      t.mock.method(PiRpcProcess, 'spawn', async () => proc as unknown as PiRpcProcess)
      Reflect.set(agent, 'store', {
        get: () => ({ cwd: process.cwd(), sessionFile: '/tmp/thinking-test.jsonl' }),
        upsert() {},
        delete() {}
      })
      const result = load
        ? await agent.loadSession({ sessionId: 's1', cwd: process.cwd(), mcpServers: [] })
        : await agent.newSession({ cwd: process.cwd(), mcpServers: [] })
      assert.equal(result.modes?.currentModeId, state.thinkingLevel)
      assert.deepEqual(
        result.modes?.availableModes.map(mode => mode.id),
        levels
      )
      const option = result.configOptions?.find(option => option.id === 'thought_level')
      assert.equal(option?.currentValue, state.thinkingLevel)
      assert.deepEqual(
        option?.options.map(option => ('value' in option ? option.value : undefined)),
        levels
      )
    })
  }
}

for (const failure of ['discovery', 'missing-current', 'inconsistent-current', 'state']) {
  test(`load configuration ${failure} failure closes restored child and preserves history for retry`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-load-thinking-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
    const sessionFile = join(root, 'history.jsonl')
    writeFileSync(sessionFile, 'persisted history\n')
    const store = new SessionStore(join(root, 'map.json'))
    store.upsert({ sessionId: 's1', cwd: root, sessionFile })
    const { agent, conn, proc } = fixture()
    const sessions = new SessionManager()
    Reflect.set(agent, 'sessions', sessions)
    Reflect.set(agent, 'store', store)
    let existingDisposed = 0
    let restoredDisposed = 0
    let historyReads = 0
    let shouldFail = true
    let spawns = 0
    sessions.getOrCreate('existing', {
      cwd: root,
      mcpServers: [],
      conn: asAgentConn(conn),
      proc: {
        onEvent: () => () => {},
        dispose() {
          existingDisposed++
        }
      } as unknown as PiRpcProcess
    })
    t.after(() => sessions.disposeAll())
    t.mock.method(PiRpcProcess, 'spawn', async () => {
      spawns++
      return {
        ...proc,
        dispose() {
          restoredDisposed++
        },
        async getState() {
          if (shouldFail && failure === 'state') throw new Error('state unavailable')
          if (shouldFail && failure === 'missing-current') return {}
          if (shouldFail && failure === 'inconsistent-current') return { thinkingLevel: 'medium' }
          return proc.getState()
        },
        async getAvailableThinkingLevels() {
          if (shouldFail && failure === 'discovery') throw new Error('discovery unavailable')
          return proc.getAvailableThinkingLevels()
        },
        async getMessages() {
          historyReads++
          return { messages: [{ role: 'user', content: 'persisted prompt' }] }
        }
      } as unknown as PiRpcProcess
    })
    await assert.rejects(agent.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] }))
    assert.equal(restoredDisposed, 1)
    assert.equal(sessions.maybeGet('s1'), undefined)
    assert.ok(sessions.maybeGet('existing'))
    assert.equal(existingDisposed, 0)
    assert.equal(historyReads, 0)
    assert.equal(conn.updates.length, 0)
    assert.equal(readFileSync(sessionFile, 'utf8'), 'persisted history\n')
    assert.equal(store.get('s1')?.sessionFile, sessionFile)
    shouldFail = false
    const result = await agent.loadSession({ sessionId: 's1', cwd: root, mcpServers: [] })
    assert.equal(result.modes?.currentModeId, 'max')
    assert.equal(spawns, 2)
    assert.equal(restoredDisposed, 1)
    assert.equal(historyReads, 1)
    assert.ok(conn.updates.some(update => update.update.sessionUpdate === 'user_message_chunk'))
    assert.equal(readFileSync(sessionFile, 'utf8'), 'persisted history\n')
  })
}

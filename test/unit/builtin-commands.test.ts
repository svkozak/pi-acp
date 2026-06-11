import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class FakeSessions {
  constructor(private readonly session: any) {}
  get(_id: string) {
    return this.session
  }
}

test('PiAcpAgent: /steering is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getState = async () => ({ steeringMode: 'one-at-a-time' })

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/steering' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Steering mode: one-at-a-time/)
})

test('PiAcpAgent: /name sets session display name adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let setTo: string | null = null
  proc.setSessionName = async (name: string) => {
    setTo = name
  }

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({ sessionId: 's1', proc, fileCommands: [] }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/name My Session' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(setTo, 'My Session')
  const info = conn.updates.find(u => (u as any).update?.sessionUpdate === 'session_info_update')
  assert.equal((info as any)?.update?.title, 'My Session')

  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Session name set: My Session/)
})

test('PiAcpAgent: /reload is handled adapter-side', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any
  proc.getCommands = async () => ({ commands: [] })

  let reloaded = false

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    isBusy: () => false,
    reload: async () => {
      reloaded = true
    }
  }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/reload' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(proc.prompts.length, 0)
  assert.equal(reloaded, true)

  const commandsUpdate = conn.updates.find(u => (u as any).update?.sessionUpdate === 'available_commands_update')
  assert.ok(commandsUpdate)
  assert.ok((commandsUpdate as any).update.availableCommands.some((c: any) => c.name === 'reload'))

  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Reloaded prompts, skills, extensions, and context files/)
})

test('PiAcpAgent: /reload waits until idle', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess() as any

  let reloaded = false

  const agent = new PiAcpAgent(asAgentConn(conn))
  ;(agent as any).sessions = new FakeSessions({
    sessionId: 's1',
    cwd: process.cwd(),
    proc,
    fileCommands: [],
    isBusy: () => true,
    reload: async () => {
      reloaded = true
    }
  }) as any

  const res = await agent.prompt({
    sessionId: 's1',
    prompt: [{ type: 'text', text: '/reload' }]
  } as any)

  assert.equal(res.stopReason, 'end_turn')
  assert.equal(reloaded, false)
  const last = conn.updates.at(-1)
  assert.match((last as any).update.content.text, /Wait for the current response to finish before reloading/)
})

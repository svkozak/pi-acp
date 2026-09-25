import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

class LifecycleProcess extends FakePiRpcProcess {
  disposed = false
  constructor(
    readonly sessionId: string,
    readonly sessionFile: string
  ) {
    super()
  }
  dispose() {
    this.disposed = true
  }
  async getState() {
    return { sessionId: this.sessionId, sessionFile: this.sessionFile, thinkingLevel: 'medium' }
  }
  async getAvailableThinkingLevels() {
    return ['medium']
  }
}

for (const operation of ['new', 'load'] as const) {
  test(`session/${operation} preserves a running neighbor and its queued turn`, { timeout: 3000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-lifecycle-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const oldPath = process.env.PATH
    process.env.PATH = root
    t.after(() => {
      process.env.PATH = oldPath
    })
    const oldDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = root
    t.after(() => {
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = oldDir
    })
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))
    t.after(() => agent.dispose())
    const procs: LifecycleProcess[] = []
    t.mock.method(PiRpcProcess, 'spawn', async () => {
      const id = `session-${procs.length}`
      const file = join(root, `${id}.jsonl`)
      writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd: root }) + '\n')
      const proc = new LifecycleProcess(id, file)
      procs.push(proc)
      return proc
    })
    const first = await agent.newSession({ cwd: root, mcpServers: [] })
    const prompt = (text: string) => agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text }] })
    const running = prompt('one')
    const queued = prompt('two')
    await new Promise(resolve => setImmediate(resolve))
    const second = await agent.newSession({ cwd: root, mcpServers: [] })
    if (operation === 'load') await agent.loadSession({ sessionId: second.sessionId, cwd: root, mcpServers: [] })
    assert.equal(procs[0].disposed, false, 'neighbor process must stay alive')
    procs[0].emit({ type: 'agent_settled' })
    assert.equal((await running).stopReason, 'end_turn')
    procs[0].emit({ type: 'agent_settled' })
    assert.equal((await queued).stopReason, 'end_turn')
    assert.deepEqual(
      procs[0].prompts.map(p => p.message),
      ['one', 'two']
    )
    const active = prompt('three')
    const waiting = prompt('four')
    await new Promise(resolve => setImmediate(resolve))
    const before = readFileSync(procs[0].sessionFile, 'utf8')
    await agent.closeSession({ sessionId: first.sessionId })
    assert.equal((await active).stopReason, 'cancelled')
    assert.equal((await waiting).stopReason, 'cancelled')
    assert.equal(procs[0].disposed, true)
    assert.equal(procs.at(-1)?.disposed, false)
    assert.equal(readFileSync(procs[0].sessionFile, 'utf8'), before)
    const closedSessionUpdates = () => conn.updates.filter(update => update.sessionId === first.sessionId)
    const beforeLateEvent = closedSessionUpdates()
    procs[0].emit({ type: 'agent_settled' })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(closedSessionUpdates(), beforeLateEvent)
  })
}

test('acknowledged prompt and queued prompt reject when the real subprocess exits', { timeout: 3000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-exit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const command = join(root, 'pi')
  writeFileSync(
    command,
    `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input: process.stdin}).on('line', line => {
  const cmd = JSON.parse(line);
  process.stdout.write(JSON.stringify({type: 'response', id: cmd.id, command: cmd.type, success: true, data: {}}) + '\\n');
  if (cmd.type === 'abort') process.exitCode = 7, process.stdin.destroy();
});
`,
    { mode: 0o755 }
  )
  const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: command })
  t.after(() => proc.dispose())
  const session = new PiAcpSession({
    sessionId: 'exit',
    cwd: root,
    mcpServers: [],
    proc,
    conn: asAgentConn(new FakeAgentSideConnection())
  })
  const first = assert.rejects(session.prompt('one'), /pi process exited/)
  const second = assert.rejects(session.prompt('two'), /pi process exited/)
  await proc.abort()
  await Promise.all([first, second])
  await assert.rejects(session.prompt('three'), /pi process exited/)
  await assert.rejects(proc.getState(), /pi process exited/)
})

test(
  'reloading the same session cancels its pending turns and leaves its neighbor alive',
  { timeout: 3000 },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-reload-'))
    const oldDir = process.env.PI_CODING_AGENT_DIR
    const oldPath = process.env.PATH
    process.env.PI_CODING_AGENT_DIR = root
    process.env.PATH = root
    t.after(() => {
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = oldDir
      process.env.PATH = oldPath
      rmSync(root, { recursive: true, force: true })
    })
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    t.after(() => agent.dispose())
    const procs: LifecycleProcess[] = []
    t.mock.method(PiRpcProcess, 'spawn', async () => {
      const id = `reload-${procs.length}`
      const file = join(root, `${id}.jsonl`)
      writeFileSync(file, JSON.stringify({ type: 'session', version: 3, id, cwd: root }) + '\n')
      const proc = new LifecycleProcess(id, file)
      procs.push(proc)
      return proc
    })
    const first = await agent.newSession({ cwd: root, mcpServers: [] })
    await agent.newSession({ cwd: root, mcpServers: [] })
    const one = agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'one' }] })
    const two = agent.prompt({ sessionId: first.sessionId, prompt: [{ type: 'text', text: 'two' }] })
    await new Promise(resolve => setImmediate(resolve))
    await agent.loadSession({ sessionId: first.sessionId, cwd: root, mcpServers: [] })
    assert.equal((await one).stopReason, 'cancelled')
    assert.equal((await two).stopReason, 'cancelled')
    assert.equal(procs[0].disposed, true)
    assert.equal(procs[1].disposed, false)
    assert.equal(procs[2].disposed, false)
  }
)

test('client disconnect terminates all Pi subprocesses', { timeout: 5000 }, async t => {
  const { spawn } = await import('node:child_process')
  const { createInterface } = await import('node:readline')
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-disconnect-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const command = join(root, 'pi')
  const exits = join(root, 'exits')
  writeFileSync(
    command,
    `#!${process.execPath}
if (process.argv.includes('--version')) process.exit(0);
const fs = require('node:fs');
process.on('SIGTERM', () => { fs.appendFileSync(${JSON.stringify(exits)}, process.pid + '\\n'); process.exit(0); });
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const cmd = JSON.parse(line);
  const data = cmd.type === 'get_available_models' ? {models: [{provider: 'test', id: 'model'}]} : cmd.type === 'get_available_thinking_levels' ? {levels: ['medium']} : {sessionId: String(process.pid), thinkingLevel: 'medium'};
  process.stdout.write(JSON.stringify({type: 'response', id: cmd.id, command: cmd.type, success: true, data}) + '\\n');
});
`,
    { mode: 0o755 }
  )
  const adapter = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: process.cwd(),
    stdio: 'pipe',
    env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_ACP_PI_COMMAND: command, PATH: root }
  })
  const pids: number[] = []
  t.after(() => {
    adapter.kill()
    for (const pid of pids) {
      try {
        process.kill(pid)
      } catch {
        /* already exited */
      }
    }
  })
  const lines = createInterface({ input: adapter.stdout })
  const pending = new Map<number, (value: Record<string, unknown>) => void>()
  lines.on('line', line => {
    const message = JSON.parse(line)
    if (typeof message.id === 'number') pending.get(message.id)?.(message)
  })
  for (const id of [1, 2]) {
    const response = new Promise<Record<string, unknown>>(resolve => pending.set(id, resolve))
    adapter.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd: root, mcpServers: [] } }) + '\n'
    )
    const message = await response
    assert.equal(message.error, undefined)
    pids.push(Number((message.result as { sessionId: string }).sessionId))
  }
  const closed = new Promise<void>(resolve => adapter.once('exit', () => resolve()))
  adapter.stdin.end()
  await closed
  for (let attempt = 0; attempt < 100; attempt++) {
    let terminated: number[] = []
    try {
      terminated = readFileSync(exits, 'utf8').trim().split('\n').map(Number)
    } catch {
      /* waiting for SIGTERM */
    }
    if (pids.every(pid => terminated.includes(pid))) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail('all Pi subprocesses must receive SIGTERM on disconnect')
})

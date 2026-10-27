import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

type SpawnCall = { sessionPath?: string; fork?: { sessionPath: string; sessionId: string } }

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-fork-'))
  const project = join(root, 'project')
  const sessions = join(root, 'agent', 'sessions', '--project--')
  mkdirSync(project, { recursive: true })
  mkdirSync(sessions, { recursive: true })
  const source = join(sessions, '0000_source.jsonl')
  writeFileSync(
    source,
    JSON.stringify({ type: 'session', version: 3, id: 'source', timestamp: '2026-10-27T00:00:00.000Z', cwd: project }) +
      '\n'
  )
  return { root, project, sessions, source }
}

async function withAgent(
  fn: (
    ctx: ReturnType<typeof setup> & { agent: PiAcpAgent; spawns: SpawnCall[]; procs: FakePiRpcProcess[] }
  ) => Promise<void>,
  onFork?: (ctx: ReturnType<typeof setup>) => void
) {
  const ctx = setup()
  const env = { home: process.env.HOME, agentDir: process.env.PI_CODING_AGENT_DIR }
  process.env.HOME = ctx.root
  process.env.PI_CODING_AGENT_DIR = join(ctx.root, 'agent')
  const originalSpawn = PiRpcProcess.spawn
  const spawns: SpawnCall[] = []
  const procs: FakePiRpcProcess[] = []
  ;(PiRpcProcess as any).spawn = async (params: SpawnCall) => {
    spawns.push(params)
    const proc = new FakePiRpcProcess() as any
    const file = params.fork ? join(ctx.sessions, `0001_${params.fork.sessionId}.jsonl`) : params.sessionPath
    if (params.fork) {
      copyFileSync(params.fork.sessionPath, file!)
      onFork?.(ctx)
    }
    proc.getState = async () => ({ sessionId: params.fork?.sessionId, sessionFile: file, thinkingLevel: 'medium' })
    proc.disposed = false
    proc.dispose = () => {
      proc.disposed = true
    }
    procs.push(proc)
    return proc
  }
  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    await fn({ ...ctx, agent, spawns, procs })
  } finally {
    PiRpcProcess.spawn = originalSpawn
    if (env.home === undefined) delete process.env.HOME
    else process.env.HOME = env.home
    if (env.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = env.agentDir
  }
}

test('PiAcpAgent: initialize advertises session/fork', async () => {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)
  assert.deepEqual((res.agentCapabilities as any).sessionCapabilities.fork, {})
})

test('PiAcpAgent: forkSession lets pi copy the session and keeps that process for the first load', async () => {
  await withAgent(async ({ agent, spawns, procs, project, source }) => {
    const before = readFileSync(source)
    const res = await agent.unstable_forkSession({ sessionId: 'source', cwd: project, mcpServers: [] } as any)

    assert.notEqual(res.sessionId, 'source')
    assert.deepEqual(spawns, [
      {
        cwd: project,
        fork: { sessionPath: source, sessionId: res.sessionId },
        piCommand: process.env.PI_ACP_PI_COMMAND
      }
    ])
    assert.ok(res.modes)
    assert.ok(readFileSync(source).equals(before))

    await agent.loadSession({ sessionId: res.sessionId, cwd: project, mcpServers: [] } as any)
    assert.equal(spawns.length, 1)
    assert.equal((procs[0] as any).disposed, false)

    // Later loads are reloads and get a fresh process as before.
    await agent.loadSession({ sessionId: res.sessionId, cwd: project, mcpServers: [] } as any)
    assert.equal(spawns.length, 2)
    assert.equal((procs[0] as any).disposed, true)
  })
})

test('PiAcpAgent: forkSession removes the copy if the source changed meanwhile', async () => {
  await withAgent(
    async ({ agent, procs, project, sessions }) => {
      await assert.rejects(
        agent.unstable_forkSession({ sessionId: 'source', cwd: project, mcpServers: [] } as any),
        (e: any) => /changed while it was being forked/.test(e.message)
      )
      assert.equal((procs[0] as any).disposed, true)
      assert.deepEqual(
        readdirSync(sessions).filter(f => f.startsWith('0001_')),
        []
      )
    },
    ({ source }) => appendFileSync(source, '{"type":"message"}\n')
  )
})

test('PiAcpAgent: forkSession refuses another project directory', async () => {
  await withAgent(async ({ agent, spawns, root }) => {
    await assert.rejects(
      agent.unstable_forkSession({ sessionId: 'source', cwd: root, mcpServers: [] } as any),
      (e: any) => /own project directory/.test(JSON.stringify(e.data))
    )
    assert.equal(spawns.length, 0)
  })
})

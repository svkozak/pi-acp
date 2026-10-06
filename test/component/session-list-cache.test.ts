import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function writeSession(dir: string, id: string, minute: number): string {
  const file = join(dir, `${id}.jsonl`)
  const ts = `2026-02-11T00:${String(minute).padStart(2, '0')}:00.000Z`
  writeFileSync(
    file,
    [
      JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd: '/tmp/project' }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: ts, message: { role: 'user', content: `Prompt ${id}` } })
    ].join('\n') + '\n'
  )
  return file
}

test('listSessions re-reads only session files that changed since the previous call', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const dir = join(root, 'sessions', '--tmp-project--')
  mkdirSync(dir, { recursive: true })
  const files = ['a', 'b', 'c'].map((id, i) => writeSession(dir, id, i))

  const opened: string[] = []
  const originalOpenSync = fs.openSync
  ;(fs as any).openSync = (path: fs.PathLike, ...rest: any[]) => {
    if (String(path).startsWith(root)) opened.push(String(path))
    return (originalOpenSync as any)(path, ...rest)
  }
  syncBuiltinESMExports()

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
    const list = () => agent.listSessions({ cwd: '/tmp/project', cursor: null, _meta: null } as any)

    const first = await list()
    assert.deepEqual(
      first.sessions.map(s => s.title),
      ['Prompt c', 'Prompt b', 'Prompt a']
    )
    assert.ok(opened.length > 0)

    opened.length = 0
    await list()
    assert.deepEqual(opened, [])

    appendFileSync(
      files[0],
      JSON.stringify({ type: 'session_info', id: 'si', timestamp: '2026-02-11T00:00:30.000Z', name: 'Renamed' }) + '\n'
    )
    const third = await list()
    assert.deepEqual([...new Set(opened)], [files[0]])
    assert.equal(third.sessions.find(s => s.sessionId === 'a')?.title, 'Renamed')
  } finally {
    ;(fs as any).openSync = originalOpenSync
    syncBuiltinESMExports()
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

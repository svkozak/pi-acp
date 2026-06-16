import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

test('PiAcpAgent: unstable_listSessions defaults to lastSessionCwd when cwd param is omitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))

  const dirA = join(root, 'sessions', '--a--')
  const dirB = join(root, 'sessions', '--b--')
  mkdirSync(dirA, { recursive: true })
  mkdirSync(dirB, { recursive: true })

  writeFileSync(
    join(dirA, '1.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-a',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/cwd/a'
    }) +
      '\n' +
      JSON.stringify({
        type: 'session_info',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        name: 'A'
      }) +
      '\n',
    { encoding: 'utf8' }
  )

  writeFileSync(
    join(dirB, '2.jsonl'),
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'sess-b',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/cwd/b'
    }) +
      '\n' +
      JSON.stringify({
        type: 'session_info',
        id: 'b1b2c3d4',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        name: 'B'
      }) +
      '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn))

    ;(agent as any).lastSessionCwd = '/cwd/a'

    const listed = await agent.unstable_listSessions({} as any)
    assert.equal(listed.sessions.length, 1)
    assert.equal(listed.sessions[0]?.sessionId, 'sess-a')
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { createSessionAgentDir, removeSessionAgentDir } from '../../src/acp/session-mcp.js'

let root: string
let agentDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pi-acp-session-mcp-'))
  agentDir = join(root, 'agent')
  mkdirSync(join(agentDir, 'skills'), { recursive: true })
  writeFileSync(join(agentDir, 'settings.json'), '{"defaultModel":"group/fast"}')
  writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { mine: { url: 'http://127.0.0.1:1/mcp' } } }))
  process.env.PI_CODING_AGENT_DIR = agentDir
})

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR
  rmSync(root, { recursive: true, force: true })
})

const readDirConfig = (dir: string) => JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))

test('adds the ACP servers next to the ones pi already has', () => {
  const dir = createSessionAgentDir([
    {
      type: 'http',
      name: 'team',
      url: 'http://127.0.0.1:9/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer token' }]
    }
  ])
  assert.ok(dir !== undefined)

  const config = readDirConfig(dir)
  assert.deepEqual(config.mcpServers.mine, { url: 'http://127.0.0.1:1/mcp' })
  assert.deepEqual(config.mcpServers.team, {
    url: 'http://127.0.0.1:9/mcp',
    headers: { Authorization: 'Bearer token' }
  })
})

test('the session directory shares the rest of the agent directory', () => {
  const dir = createSessionAgentDir([{ type: 'http', name: 'team', url: 'http://127.0.0.1:9/mcp', headers: [] }])
  assert.ok(dir !== undefined)
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), '{"defaultModel":"group/fast"}')
  assert.ok(existsSync(join(dir, 'skills')))
})

test('passes stdio servers on, with their environment', () => {
  const dir = createSessionAgentDir([
    { name: 'tools', command: 'npx', args: ['-y', 'tools-mcp'], env: [{ name: 'KEY', value: 'x' }] }
  ])
  assert.ok(dir !== undefined)
  assert.deepEqual(readDirConfig(dir).mcpServers.tools, {
    command: 'npx',
    args: ['-y', 'tools-mcp'],
    env: { KEY: 'x' }
  })
})

test('nothing to add means pi keeps its own agent directory', () => {
  assert.equal(createSessionAgentDir([]), undefined)
  assert.equal(
    createSessionAgentDir([{ type: 'sse', name: 'legacy', url: 'http://127.0.0.1:9/sse', headers: [] }]),
    undefined
  )
})

test('keeps MCP sign-in tokens in the agent directory', () => {
  const dir = createSessionAgentDir([{ type: 'http', name: 'team', url: 'http://127.0.0.1:9/mcp', headers: [] }])
  assert.ok(dir !== undefined)
  writeFileSync(join(dir, 'mcp-auth.json'), '{"team":"token"}')
  assert.equal(readFileSync(join(agentDir, 'mcp-auth.json'), 'utf8'), '{"team":"token"}')
})

test('removing the session directory leaves the agent directory alone', () => {
  const dir = createSessionAgentDir([{ type: 'http', name: 'team', url: 'http://127.0.0.1:9/mcp', headers: [] }])
  assert.ok(dir !== undefined)
  removeSessionAgentDir(dir)
  assert.equal(existsSync(dir), false)
  assert.equal(readDirConfig(agentDir).mcpServers.mine.url, 'http://127.0.0.1:1/mcp')
})

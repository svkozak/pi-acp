import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const originalAgentDir = process.env.PI_CODING_AGENT_DIR
const originalEnableMcp = process.env.PI_ACP_ENABLE_MCP
let dirs: string[] = []

beforeEach(() => {
  delete process.env.PI_ACP_ENABLE_MCP
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-agent-dir-'))
  dirs.push(dir)
  process.env.PI_CODING_AGENT_DIR = dir
})

afterEach(() => {
  if (originalAgentDir == null) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir

  if (originalEnableMcp == null) delete process.env.PI_ACP_ENABLE_MCP
  else process.env.PI_ACP_ENABLE_MCP = originalEnableMcp

  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

async function initializeMcpCapabilities() {
  const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
  const res = await agent.initialize({ protocolVersion: 1 } as any)
  assert.ok(res.agentCapabilities)
  assert.ok(res.agentCapabilities.mcpCapabilities)
  return res.agentCapabilities.mcpCapabilities
}

test('MCP capabilities default to false for plain pi (no pi-mcp-adapter detected)', async () => {
  assert.deepEqual(await initializeMcpCapabilities(), { http: false, sse: false, acp: false })
})

test('PI_ACP_ENABLE_MCP=true forces MCP capability advertisement on', async () => {
  process.env.PI_ACP_ENABLE_MCP = 'true'
  assert.deepEqual(await initializeMcpCapabilities(), { http: true, sse: true, acp: true })
})

test('PI_ACP_ENABLE_MCP=false forces MCP capability advertisement off', async () => {
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, 'npm', 'node_modules', 'pi-mcp-adapter'), { recursive: true })
  process.env.PI_ACP_ENABLE_MCP = 'false'
  assert.deepEqual(await initializeMcpCapabilities(), { http: false, sse: false, acp: false })
})

test('MCP capabilities turn on when pi-mcp-adapter package dir is detected', async () => {
  mkdirSync(join(process.env.PI_CODING_AGENT_DIR!, 'npm', 'node_modules', 'pi-mcp-adapter'), { recursive: true })
  assert.deepEqual(await initializeMcpCapabilities(), { http: true, sse: true, acp: true })
})

test('MCP capabilities turn on when settings packages include pi-mcp-adapter', async () => {
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, 'settings.json'),
    JSON.stringify({ packages: ['npm:pi-mcp-adapter'] })
  )
  assert.deepEqual(await initializeMcpCapabilities(), { http: true, sse: true, acp: true })
})

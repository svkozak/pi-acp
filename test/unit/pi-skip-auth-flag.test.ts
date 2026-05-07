import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const SPAWN_SENTINEL = 'spawn-reached'

class SpawnSentinelSessions {
  async create() {
    throw new Error(SPAWN_SENTINEL)
  }
}

class FailIfSpawnedSessions {
  async create() {
    throw new Error('pi should not be spawned when no auth is configured and skip flag is unset')
  }
}

const PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY',
  'CEREBRAS_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY',
  'ZAI_API_KEY', 'MISTRAL_API_KEY', 'MINIMAX_API_KEY', 'MINIMAX_CN_API_KEY',
  'HF_TOKEN', 'OPENCODE_API_KEY', 'KIMI_API_KEY',
  'COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'
]

function setupEmptyAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-skip-auth-'))
  writeFileSync(join(dir, 'auth.json'), '{}', 'utf-8')
  writeFileSync(join(dir, 'models.json'), '{}', 'utf-8')
  return dir
}

function saveAndClearAuthEnv() {
  const saved: Record<string, string | undefined> = {}
  for (const k of PROVIDER_ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  saved.PI_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR
  saved.PI_ACP_SKIP_PI_AUTH = process.env.PI_ACP_SKIP_PI_AUTH
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(saved)) {
    if (v == null) delete process.env[k]
    else process.env[k] = v
  }
}

test('PI_ACP_SKIP_PI_AUTH unset: newSession still rejects with AUTH_REQUIRED when no auth configured', async () => {
  const saved = saveAndClearAuthEnv()
  delete process.env.PI_ACP_SKIP_PI_AUTH
  process.env.PI_CODING_AGENT_DIR = setupEmptyAgentDir()

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FailIfSpawnedSessions() as any

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) => e?.code === -32000
    )
  } finally {
    restoreEnv(saved)
  }
})

test("PI_ACP_SKIP_PI_AUTH='true': newSession bypasses auth gate and proceeds to spawn", async () => {
  const saved = saveAndClearAuthEnv()
  process.env.PI_ACP_SKIP_PI_AUTH = 'true'
  process.env.PI_CODING_AGENT_DIR = setupEmptyAgentDir()

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new SpawnSentinelSessions() as any

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) => e?.message === SPAWN_SENTINEL && e?.code !== -32000
    )
  } finally {
    restoreEnv(saved)
  }
})

test("PI_ACP_SKIP_PI_AUTH='false': auth gate still runs (only 'true' opts out)", async () => {
  const saved = saveAndClearAuthEnv()
  process.env.PI_ACP_SKIP_PI_AUTH = 'false'
  process.env.PI_CODING_AGENT_DIR = setupEmptyAgentDir()

  try {
    const conn = new FakeAgentSideConnection()
    const agent = new PiAcpAgent(asAgentConn(conn), {} as any)
    ;(agent as any).sessions = new FailIfSpawnedSessions() as any

    await assert.rejects(
      () => agent.newSession({ cwd: process.cwd(), mcpServers: [] } as any),
      (e: any) => e?.code === -32000
    )
  } finally {
    restoreEnv(saved)
  }
})

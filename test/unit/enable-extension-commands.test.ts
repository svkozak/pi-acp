import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEnableExtensionCommands } from '../../src/acp/pi-settings.js'

let originalEnv: string | undefined
let originalAgentDir: string | undefined
let tmpAgentDir: string | null = null
let tmpCwd: string | null = null

beforeEach(() => {
  originalEnv = process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS
  originalAgentDir = process.env.PI_CODING_AGENT_DIR
  delete process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS

  tmpAgentDir = mkdtempSync(join(tmpdir(), 'pi-acp-agent-'))
  tmpCwd = mkdtempSync(join(tmpdir(), 'pi-acp-cwd-'))
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir
})

afterEach(() => {
  if (originalEnv === undefined) delete process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS
  else process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS = originalEnv

  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir

  if (tmpAgentDir) rmSync(tmpAgentDir, { recursive: true, force: true })
  if (tmpCwd) rmSync(tmpCwd, { recursive: true, force: true })
  tmpAgentDir = null
  tmpCwd = null
})

test('getEnableExtensionCommands: defaults to true when nothing is configured', () => {
  assert.equal(getEnableExtensionCommands(tmpCwd!), true)
})

test('getEnableExtensionCommands: env var "false" wins over default', () => {
  process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS = 'false'
  assert.equal(getEnableExtensionCommands(tmpCwd!), false)
})

test('getEnableExtensionCommands: env var "true" is respected', () => {
  process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS = 'true'
  assert.equal(getEnableExtensionCommands(tmpCwd!), true)
})

test('getEnableExtensionCommands: env var takes precedence over project + global settings', () => {
  writeFileSync(join(tmpAgentDir!, 'settings.json'), JSON.stringify({ enableExtensionCommands: false }))
  mkdirSync(join(tmpCwd!, '.pi'), { recursive: true })
  writeFileSync(join(tmpCwd!, '.pi', 'settings.json'), JSON.stringify({ enableExtensionCommands: false }))

  process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS = 'true'
  assert.equal(getEnableExtensionCommands(tmpCwd!), true)
})

test('getEnableExtensionCommands: project setting overrides global setting', () => {
  writeFileSync(join(tmpAgentDir!, 'settings.json'), JSON.stringify({ enableExtensionCommands: true }))
  mkdirSync(join(tmpCwd!, '.pi'), { recursive: true })
  writeFileSync(join(tmpCwd!, '.pi', 'settings.json'), JSON.stringify({ enableExtensionCommands: false }))

  assert.equal(getEnableExtensionCommands(tmpCwd!), false)
})

test('getEnableExtensionCommands: non-boolean setting value falls back to default', () => {
  writeFileSync(join(tmpAgentDir!, 'settings.json'), JSON.stringify({ enableExtensionCommands: 'yes' }))
  assert.equal(getEnableExtensionCommands(tmpCwd!), true)
})

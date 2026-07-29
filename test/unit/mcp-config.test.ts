import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acpMcpServerToPiConfig, writeManagedMcpConfig } from '../../src/acp/mcp/config.js'
import type { McpServer } from '@agentclientprotocol/sdk'

function stdio(name: string, overrides: Partial<any> = {}): McpServer {
  return {
    name,
    command: 'node',
    args: ['server.js'],
    env: [{ name: 'FOO', value: 'bar' }],
    ...overrides
  } as McpServer
}

test('acpMcpServerToPiConfig: stdio server maps command/args/env', () => {
  const cfg = acpMcpServerToPiConfig(stdio('my-server'))
  assert.deepEqual(cfg, {
    command: 'node',
    args: ['server.js'],
    env: { FOO: 'bar' }
  })
})

test('acpMcpServerToPiConfig: stdio server omits env when absent', () => {
  const cfg = acpMcpServerToPiConfig({ name: 's', command: 'bin', args: [], env: [] } as unknown as McpServer)
  assert.deepEqual(cfg, { command: 'bin', args: [] })
})

test('acpMcpServerToPiConfig: http server maps url + headers', () => {
  const server: McpServer = {
    type: 'http',
    name: 'remote',
    url: 'https://example.com/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer x' }]
  } as McpServer
  assert.deepEqual(acpMcpServerToPiConfig(server), {
    type: 'http',
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer x' }
  })
})

test('acpMcpServerToPiConfig: sse server maps url + headers', () => {
  const server: McpServer = {
    type: 'sse',
    name: 'remote',
    url: 'https://example.com/sse',
    headers: []
  } as McpServer
  assert.deepEqual(acpMcpServerToPiConfig(server), {
    type: 'sse',
    url: 'https://example.com/sse'
  })
})

test('acpMcpServerToPiConfig: acp server returns null (handled by bridge)', () => {
  const server: McpServer = { type: 'acp', name: 'acp-tools', id: 'abc-123' } as McpServer
  assert.equal(acpMcpServerToPiConfig(server), null)
})

test('writeManagedMcpConfig: writes a new file when none exists', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
  try {
    const { restore } = writeManagedMcpConfig(cwd, {
      'my-server': { command: 'node', args: ['s.js'] }
    })
    const path = join(cwd, '.pi', 'mcp.json')
    assert.ok(existsSync(path))
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    assert.deepEqual(data.mcpServers['my-server'], { command: 'node', args: ['s.js'] })
    assert.equal(data._piAcpManaged, true)

    restore()
    // No original existed -> the managed file is removed.
    assert.ok(!existsSync(path))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeManagedMcpConfig: merges with existing user file and restores it', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
  try {
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    const path = join(cwd, '.pi', 'mcp.json')
    writeFileSync(path, JSON.stringify({ mcpServers: { 'user-srv': { command: 'u', args: [] } } }))

    const { restore } = writeManagedMcpConfig(cwd, {
      'acp-srv': { command: 'node', args: ['a.js'] }
    })

    const data = JSON.parse(readFileSync(path, 'utf-8'))
    assert.ok(data.mcpServers['user-srv'], 'user server preserved')
    assert.ok(data.mcpServers['acp-srv'], 'managed server added')
    assert.equal(data._piAcpManaged, true)

    restore()
    const restored = JSON.parse(readFileSync(path, 'utf-8'))
    assert.ok(restored.mcpServers['user-srv'], 'user server still there after restore')
    assert.ok(!restored.mcpServers['acp-srv'], 'managed server removed after restore')
    assert.ok(!('_piAcpManaged' in restored), 'marker removed after restore')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeManagedMcpConfig: refuses to overwrite user config when the backup cannot be created', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
  try {
    mkdirSync(join(cwd, '.pi'), { recursive: true })
    const path = join(cwd, '.pi', 'mcp.json')
    const original = JSON.stringify({ mcpServers: { 'user-srv': { command: 'u', args: [] } } })
    writeFileSync(path, original)

    // Dangling symlink at the backup path: existsSync() follows it (false), but
    // copyFileSync() fails writing through it — simulating a failed backup while
    // the config file itself is still writable.
    try {
      symlinkSync(join(cwd, 'missing-dir', 'target'), `${path}.pi-acp.bak`)
    } catch {
      t.skip('symlinks not supported on this platform')
      return
    }

    const { restore } = writeManagedMcpConfig(cwd, {
      'acp-srv': { command: 'node', args: ['a.js'] }
    })

    assert.equal(readFileSync(path, 'utf-8'), original, 'user config untouched when backup fails')
    restore()
    assert.ok(existsSync(path), 'restore must not delete the user config')
    assert.equal(readFileSync(path, 'utf-8'), original, 'user config intact after restore')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('writeManagedMcpConfig: no-op restore when no managed servers', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
  try {
    const { restore } = writeManagedMcpConfig(cwd, {})
    const path = join(cwd, '.pi', 'mcp.json')
    assert.ok(!existsSync(path))
    restore() // should not throw
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

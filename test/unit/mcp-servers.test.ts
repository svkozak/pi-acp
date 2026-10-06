import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { PI_ACP_MCP_SERVERS_ENV, resolveMcpExtensionPath, serializeMcpServers } from '../../src/mcp/mcp-bridge.js'

test('serializeMcpServers keeps stdio/http/sse and drops malformed entries', () => {
  const out = serializeMcpServers([
    // stdio (default shape: no `type`)
    {
      name: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: [{ name: 'FOO', value: 'bar' }]
    } as any,
    // http
    {
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }]
    } as any,
    // acp transport passes through so the extension can report it as skipped
    { name: 'acp-thing', type: 'acp', id: 'x' } as any,
    // malformed: stdio without command
    { name: 'broken' } as any,
    // malformed: http without url
    { name: 'broken-http', type: 'http' } as any
  ])

  assert.deepEqual(out, [
    {
      name: 'fs',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: [{ name: 'FOO', value: 'bar' }]
    },
    {
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer x' }]
    },
    { name: 'acp-thing', type: 'acp' }
  ])
})

test('serializeMcpServers handles empty and undefined input', () => {
  assert.deepEqual(serializeMcpServers(undefined), [])
  assert.deepEqual(serializeMcpServers([]), [])
})

function writeFakePi(root: string): string {
  const fixture = join(root, 'fake-pi.cjs')
  writeFileSync(
    fixture,
    [
      "const { appendFileSync } = require('node:fs')",
      "const readline = require('node:readline')",
      'const out = process.env.PI_ACP_FAKE_PI_OUT',
      "if (out) appendFileSync(out, JSON.stringify({ argv: process.argv.slice(2), mcpEnv: process.env.PI_ACP_MCP_SERVERS ?? null }) + '\\n')",
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      '  const command = JSON.parse(line)',
      "  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: {} }) + '\\n')",
      '  setTimeout(() => process.exit(0), 20)',
      '})'
    ].join('\n')
  )
  return fixture
}

function writeLauncher(root: string, fixture: string): string {
  const launcher = join(root, 'pi')
  writeFileSync(launcher, `#!/usr/bin/env node\nrequire(${JSON.stringify(fixture)})\n`)
  chmodSync(launcher, 0o755)
  return launcher
}

test(
  'PiRpcProcess injects the bundled extension and PI_ACP_MCP_SERVERS when mcpServers are set',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-'))
    const fixture = writeFakePi(root)
    const launcher = writeLauncher(root, fixture)
    const outFile = join(root, 'spawn.jsonl')
    const previous = process.env.PI_ACP_FAKE_PI_OUT
    process.env.PI_ACP_FAKE_PI_OUT = outFile

    try {
      const proc = await PiRpcProcess.spawn({
        cwd: root,
        piCommand: launcher,
        mcpServers: [
          { name: 'fs', command: 'npx', args: ['-y', 'fs-mcp'], env: [] },
          { name: 'web', type: 'http', url: 'https://mcp.example.com/mcp', headers: [] }
        ] as any
      })
      proc.dispose()
      await new Promise(resolve => setTimeout(resolve, 50))

      const record = JSON.parse(readFileSync(outFile, 'utf8').trim())

      const eIndex = record.argv.indexOf('-e')
      assert.notEqual(eIndex, -1, 'expected -e flag in pi argv')
      assert.match(record.argv[eIndex + 1], /pi-mcp-extension\.(js|ts)$/)

      const specs = JSON.parse(record.mcpEnv)
      assert.deepEqual(specs, [
        { name: 'fs', command: 'npx', args: ['-y', 'fs-mcp'], env: [] },
        { name: 'web', type: 'http', url: 'https://mcp.example.com/mcp', headers: [] }
      ])
    } finally {
      if (previous === undefined) delete process.env.PI_ACP_FAKE_PI_OUT
      else process.env.PI_ACP_FAKE_PI_OUT = previous
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test(
  'PiRpcProcess does not pass -e or PI_ACP_MCP_SERVERS without mcpServers',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-none-'))
    const fixture = writeFakePi(root)
    const launcher = writeLauncher(root, fixture)
    const outFile = join(root, 'spawn.jsonl')
    const previous = process.env.PI_ACP_FAKE_PI_OUT
    const previousMcp = process.env[PI_ACP_MCP_SERVERS_ENV]
    process.env.PI_ACP_FAKE_PI_OUT = outFile
    delete process.env[PI_ACP_MCP_SERVERS_ENV]

    try {
      const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher })
      proc.dispose()
      await new Promise(resolve => setTimeout(resolve, 50))

      const record = JSON.parse(readFileSync(outFile, 'utf8').trim())
      assert.equal(record.argv.includes('-e'), false)
      assert.equal(record.mcpEnv, null)
    } finally {
      if (previous === undefined) delete process.env.PI_ACP_FAKE_PI_OUT
      else process.env.PI_ACP_FAKE_PI_OUT = previous
      if (previousMcp !== undefined) process.env[PI_ACP_MCP_SERVERS_ENV] = previousMcp
      rmSync(root, { recursive: true, force: true })
    }
  }
)

test('resolveMcpExtensionPath finds a loadable extension file', () => {
  const p = resolveMcpExtensionPath()
  assert.ok(p, 'expected an extension path')
  assert.match(p!, /pi-mcp-extension\.(js|ts)$/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { getMcpBridgeExtensionPath } from '../../src/mcp-bridge/extension-path.js'
import { MCP_SERVERS_ENV } from '../../src/mcp-bridge/servers.js'

// A fake `pi` that records how it was invoked, answers RPC requests so the
// spawn handshake completes, and idles until disposed.
const FAKE_PI = `#!/usr/bin/env node
const fs = require('node:fs')
const readline = require('node:readline')
if (process.env.REC) {
  fs.writeFileSync(
    process.env.REC,
    JSON.stringify({ argv: process.argv.slice(1), mcpServers: process.env.PI_ACP_MCP_SERVERS ?? null })
  )
}
readline
  .createInterface({ input: process.stdin })
  .on('line', line => {
    try {
      const msg = JSON.parse(line)
      if (msg.id) {
        process.stdout.write(
          JSON.stringify({ type: 'response', id: msg.id, command: msg.command, success: true, data: {} }) + '\\n'
        )
      }
    } catch {
      // ignore non-JSON lines
    }
  })
setInterval(() => {}, 1000)
`

function setupFakePi(t: test.TestContext): { piCommand: string; recordPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-mcp-spawn-'))
  const piCommand = join(dir, 'fake-pi.sh')
  const recordPath = join(dir, 'record.json')
  writeFileSync(piCommand, FAKE_PI)
  chmodSync(piCommand, 0o755)
  t.after(() => {
    delete process.env.REC
    delete process.env[MCP_SERVERS_ENV]
  })
  process.env.REC = recordPath
  return { piCommand, recordPath }
}

test('PiRpcProcess.spawn: no mcpServers means no bridge extension and no env payload', async t => {
  const { piCommand, recordPath } = setupFakePi(t)

  const proc = await PiRpcProcess.spawn({ cwd: process.cwd(), piCommand })
  t.after(() => proc.dispose())

  const record = JSON.parse(readFileSync(recordPath, 'utf-8'))
  // argv[0] is the fake's own script path; the flags follow.
  assert.deepEqual(record.argv.slice(1), ['--mode', 'rpc', '--no-themes'])
  assert.equal(record.mcpServers, null)
})

test('PiRpcProcess.spawn: mcpServers arm the bridge extension and the env payload', async t => {
  const { piCommand, recordPath } = setupFakePi(t)

  const mcpServers = [
    { name: 'docs', command: 'npx', args: ['-y', 'docs-mcp'], env: [] },
    { name: 'api', type: 'http', url: 'http://127.0.0.1:8080/mcp', headers: [{ name: 'X-Key', value: 'k' }] }
  ]
  const proc = await PiRpcProcess.spawn({ cwd: process.cwd(), piCommand, mcpServers: mcpServers as never })
  t.after(() => proc.dispose())

  const record = JSON.parse(readFileSync(recordPath, 'utf-8'))
  const eIndex = record.argv.indexOf('-e')
  assert.ok(eIndex > 0, 'expected -e <bridge> in pi argv')
  assert.equal(record.argv[eIndex + 1], getMcpBridgeExtensionPath())
  assert.deepEqual(record.argv.slice(1, eIndex), ['--mode', 'rpc', '--no-themes'])
  assert.deepEqual(JSON.parse(record.mcpServers), mcpServers)
})

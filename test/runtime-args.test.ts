import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getPiArgs } from '../src/pi-rpc/command.js'
import { getQuietStartup } from '../src/acp/pi-settings.js'
import { PiRpcProcess } from '../src/pi-rpc/process.js'

test('preserves arguments with spaces and shell metacharacters without shell parsing', () => {
  const args = ['--extension', '/tmp/config with spaces/extension.ts', '--model', 'custom/a;$(echo test)']
  assert.deepEqual(getPiArgs(JSON.stringify(args)), args)
})

for (const encoded of ['', '{}', 'null', '"--model test"', '[1]', '["\\u0000"]']) {
  test(`rejects malformed PI_ACP_PI_ARGS: ${encoded}`, () => {
    assert.throws(() => getPiArgs(encoded), /PI_ACP_PI_ARGS must be a JSON array of strings/)
  })
}

test('omitting runtime arguments retains the default launch', () => {
  const previous = process.env.PI_ACP_PI_ARGS
  try {
    delete process.env.PI_ACP_PI_ARGS
    assert.deepEqual(getPiArgs(), [])
  } finally {
    if (previous === undefined) delete process.env.PI_ACP_PI_ARGS
    else process.env.PI_ACP_PI_ARGS = previous
  }
})

test('quiet startup can be injected without creating or replacing user settings', () => {
  const previous = process.env.PI_ACP_QUIET_STARTUP
  try {
    process.env.PI_ACP_QUIET_STARTUP = '1'
    assert.equal(getQuietStartup('/nonexistent/workspace'), true)
    process.env.PI_ACP_QUIET_STARTUP = '0'
    assert.equal(getQuietStartup('/nonexistent/workspace'), false)
    process.env.PI_ACP_QUIET_STARTUP = 'invalid'
    assert.throws(() => getQuietStartup('/nonexistent/workspace'), /PI_ACP_QUIET_STARTUP/)
  } finally {
    if (previous === undefined) delete process.env.PI_ACP_QUIET_STARTUP
    else process.env.PI_ACP_QUIET_STARTUP = previous
  }
})

test('forwards runtime arguments into fresh and resumed RPC subprocesses', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi runtime args '))
  const script = join(directory, 'fake pi.cjs')
  const previous = process.env.PI_ACP_PI_ARGS
  const extension = join(directory, 'extension with spaces.ts')
  const nativeArgs = [script, '--extension', extension, '--model', 'custom/a;$(echo test)']
  await writeFile(
    script,
    `
const readline = require('node:readline')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  process.stdout.write(JSON.stringify({
    type: 'response', id: request.id, command: request.type, success: true,
    data: { args: process.argv.slice(2) }
  }) + '\\n')
})
`
  )
  try {
    process.env.PI_ACP_PI_ARGS = JSON.stringify(nativeArgs)
    for (const sessionPath of [undefined, join(directory, 'existing session.jsonl')]) {
      const rpc = await PiRpcProcess.spawn({ cwd: directory, piCommand: process.execPath, sessionPath })
      try {
        assert.deepEqual(await rpc.getState(), {
          args: [
            ...nativeArgs.slice(1),
            '--mode',
            'rpc',
            '--no-themes',
            ...(sessionPath ? ['--session', sessionPath] : [])
          ]
        })
      } finally {
        rpc.dispose()
      }
    }
  } finally {
    if (previous === undefined) delete process.env.PI_ACP_PI_ARGS
    else process.env.PI_ACP_PI_ARGS = previous
    await rm(directory, { recursive: true, force: true })
  }
})

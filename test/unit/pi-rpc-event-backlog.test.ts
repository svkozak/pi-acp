import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

// A fake pi that emits an event during startup (before it answers the spawn
// handshake's get_state), like extensions do from `session_start`.
const EARLY_EVENT_PI = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'boot-1', method: 'notify', message: 'boot notify' }) + '\\n')
require('node:readline')
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

test('PiRpcProcess.spawn: events emitted during startup replay to the first subscriber', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-boot-event-'))
  const piCommand = join(dir, 'early-event-pi.sh')
  writeFileSync(piCommand, EARLY_EVENT_PI)
  chmodSync(piCommand, 0o755)

  const proc = await PiRpcProcess.spawn({ cwd: process.cwd(), piCommand })
  t.after(() => proc.dispose())

  const seen: Array<Record<string, unknown>> = []
  proc.onEvent(ev => seen.push(ev))

  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], {
    type: 'extension_ui_request',
    id: 'boot-1',
    method: 'notify',
    message: 'boot notify'
  })
})

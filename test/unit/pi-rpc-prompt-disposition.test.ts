import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

for (const [data, expected] of [
  [{ disposition: 'handled' }, 'handled'],
  [{ disposition: 'started' }, 'started'],
  [{ disposition: 'queued' }, 'queued'],
  [{ disposition: 'unknown' }, undefined],
  [{ disposition: true }, undefined],
  [undefined, undefined],
  [null, undefined]
] as const) {
  test(`prompt preserves only known dispositions: ${JSON.stringify(data)}`, async t => {
    const stdout = new PassThrough()
    const stdin = new PassThrough()
    const stderr = new PassThrough()
    t.after(() => {
      stdout.destroy()
      stdin.destroy()
      stderr.destroy()
    })
    const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr })
    const Constructor = PiRpcProcess as unknown as new (child: ChildProcessWithoutNullStreams) => PiRpcProcess
    const proc = new Constructor(child as unknown as ChildProcessWithoutNullStreams)
    stdin.on('data', chunk => {
      const request = JSON.parse(String(chunk)) as { id: string }
      stdout.write(JSON.stringify({ type: 'response', id: request.id, command: 'prompt', success: true, data }) + '\n')
    })
    assert.equal(await proc.prompt('hello'), expected)
  })
}

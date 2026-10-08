import test from 'node:test'
import assert from 'node:assert/strict'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

function rpc(response: unknown) {
  const proc = Object.create(PiRpcProcess.prototype) as PiRpcProcess
  Reflect.set(proc, 'request', async (command: unknown) => {
    assert.deepEqual(command, { type: 'get_available_thinking_levels' })
    return response
  })
  return proc
}

for (const levels of [['low', 'high', 'max'], ['off'], ['max', 'low'], ['ordinary', 'mean'], [' mean ', ' ']]) {
  test(`thinking RPC preserves returned levels ${levels}`, async () => {
    assert.deepEqual(await rpc({ success: true, data: { levels } }).getAvailableThinkingLevels(), levels)
  })
}
for (const data of [
  undefined,
  null,
  {},
  { levels: [] },
  { levels: 'high' },
  { levels: ['high', ''] },
  { levels: ['high', null] },
  { levels: [1] }
]) {
  test(`thinking RPC rejects malformed payload ${JSON.stringify(data)}`, async () => {
    await assert.rejects(rpc({ success: true, data }).getAvailableThinkingLevels(), /invalid levels/)
  })
}
test('thinking RPC propagates unsuccessful responses and transport rejection', async () => {
  await assert.rejects(
    rpc({ success: false, error: 'unsupported command' }).getAvailableThinkingLevels(),
    /unsupported command/
  )
  const proc = rpc(null)
  Reflect.set(proc, 'request', async () => {
    throw new Error('connection closed')
  })
  await assert.rejects(proc.getAvailableThinkingLevels(), /connection closed/)
})

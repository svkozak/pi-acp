import test from 'node:test'
import assert from 'node:assert/strict'
import { piCompletionStopReason } from '../../src/acp/translate/pi-stop-reason.js'

test('piCompletionStopReason: maps length and defaults other results to end_turn', () => {
  assert.equal(piCompletionStopReason([{ role: 'assistant', stopReason: 'length' }]), 'max_tokens')
  assert.equal(piCompletionStopReason([{ role: 'assistant', stopReason: 'stop' }]), 'end_turn')
  assert.equal(piCompletionStopReason(undefined), 'end_turn')
})

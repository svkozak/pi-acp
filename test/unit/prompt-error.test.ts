import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { toPromptError } from '../../src/acp/prompt-error.js'

test('provider quota JSON becomes a useful generic ACP error, without forwarding the response object', () => {
  const error = toPromptError(
    '429: {"type":"GoUsageLimitError","message":"Monthly usage limit reached. Resets in 9 days.","headers":{"Authorization":"private"}}'
  )
  assert.deepEqual(error.toErrorResponse(), {
    code: -32603,
    message: 'Internal error: 429: Monthly usage limit reached. Resets in 9 days.',
    data: undefined
  })
})

test('nested provider errors use the same path', () => {
  assert.equal(
    toPromptError('529 {"error":{"type":"overloaded_error","message":"Overloaded"}}').message,
    'Internal error: 529: Overloaded'
  )
  assert.equal(toPromptError(new Error('Connection reset')).message, 'Internal error: Connection reset')
})

test('missing reason has a generic fallback without serializing arbitrary objects', () => {
  for (const value of [
    undefined,
    null,
    '',
    '  ',
    { headers: { authorization: 'private' } },
    '{"headers":{"Authorization":"private"}}'
  ]) {
    assert.match(toPromptError(value).message, /could not complete/)
    assert.doesNotMatch(toPromptError(value).message, /private|authorization/i)
  }
})

test('error messages are bounded and specialized ACP errors retain their semantics', () => {
  assert.ok(toPromptError('x'.repeat(8000)).message.length < 4100)
  assert.equal(toPromptError(new Error('API key monthly quota exceeded')).code, -32603)
  for (const error of [RequestError.authRequired(), RequestError.invalidParams('missing session')]) {
    assert.equal(toPromptError(error), error)
  }
})

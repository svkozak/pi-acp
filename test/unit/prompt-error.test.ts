import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { toPromptError } from '../../src/acp/prompt-error.js'
import { getAuthMethods } from '../../src/acp/auth.js'

test('authentication failures preserve the provider reason and offer terminal authentication', () => {
  for (const reason of [
    '401 Your authentication token is invalid.',
    'Unauthorized',
    'Authentication failed',
    'Invalid API key',
    'Incorrect API key provided',
    'Your token has expired',
    'API key not configured',
    'No API key found for provider',
    'Missing credentials'
  ]) {
    assert.deepEqual(toPromptError(reason).toErrorResponse(), {
      code: -32000,
      message: `Authentication required: ${reason}`,
      data: { authMethods: getAuthMethods() }
    })
  }
})

test('authentication JSON is normalized and bounded without forwarding provider fields', () => {
  const reason = `Invalid API key: ${'x'.repeat(8000)}`
  const error = toPromptError(`401: ${JSON.stringify({ error: { message: reason }, headers: { secret: 'private' } })}`)
  assert.equal(error.code, -32000)
  assert.ok(error.message.length < 4100)
  assert.match(error.message, /^Authentication required: 401: Invalid API key:/)
  assert.doesNotMatch(JSON.stringify(error.toErrorResponse()), /private|secret/)
})

test('quota, billing, configuration, and permission failures do not request authentication', () => {
  for (const reason of [
    'API key monthly quota exceeded',
    '429: API key rate limit reached',
    '403: Extra Usage billing is required',
    '403 Forbidden',
    'Permission denied',
    'Provider is not configured',
    'Request 4012 exceeded the monthly quota'
  ]) {
    assert.equal(toPromptError(reason).code, -32603, reason)
  }
})

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

import test from 'node:test'
import assert from 'node:assert/strict'
import { contextTokens, contextWindowFor } from '../../src/acp/translate/usage.js'

test('contextTokens: prefers the provider-reported total', () => {
  assert.equal(contextTokens({ totalTokens: 1234, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 1234)
})

test('contextTokens: sums the components when no total is reported', () => {
  assert.equal(contextTokens({ totalTokens: 0, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }), 100)
})

test('contextTokens: reports nothing for absent, malformed or all-zero usage', () => {
  assert.equal(contextTokens(undefined), null)
  assert.equal(contextTokens('nope'), null)
  assert.equal(contextTokens({ totalTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null)
  // A partial usage object is not silently treated as a smaller one.
  assert.equal(contextTokens({ input: 1, output: 2 }), null)
})

test('contextWindowFor: matches on provider and id together', () => {
  const models = {
    models: [
      { provider: 'alpha', id: 'shared', contextWindow: 100 },
      { provider: 'beta', id: 'shared', contextWindow: 200 }
    ]
  }

  assert.equal(contextWindowFor(models, 'beta', 'shared'), 200)
  assert.equal(contextWindowFor(models, 'gamma', 'shared'), null)
})

test('contextWindowFor: tolerates a missing, zero or unreadable window', () => {
  assert.equal(contextWindowFor({ models: [{ provider: 'a', id: 'm' }] }, 'a', 'm'), null)
  assert.equal(contextWindowFor({ models: [{ provider: 'a', id: 'm', contextWindow: 0 }] }, 'a', 'm'), null)
  assert.equal(contextWindowFor({}, 'a', 'm'), null)
  assert.equal(contextWindowFor(undefined, 'a', 'm'), null)
})

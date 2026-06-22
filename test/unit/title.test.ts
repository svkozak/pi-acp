import assert from 'node:assert/strict'
import test from 'node:test'

import { fallbackTitleFromPrompt, sanitizeGeneratedTitle, shouldAutoTitlePrompt } from '../../src/acp/title.js'

test('sanitizeGeneratedTitle removes quotes, whitespace, and trailing punctuation', () => {
  assert.equal(sanitizeGeneratedTitle('  "Fix Login Redirect Loop."  '), 'Fix Login Redirect Loop')
})

test('sanitizeGeneratedTitle limits long titles', () => {
  const title = sanitizeGeneratedTitle('a'.repeat(100))

  assert.equal(title.length, 80)
})

test('fallbackTitleFromPrompt derives a short title from the prompt', () => {
  assert.equal(
    fallbackTitleFromPrompt('Please fix the login redirect loop in auth before release.'),
    'Please fix the login redirect loop in auth'
  )
})

test('shouldAutoTitlePrompt ignores empty prompts and slash commands', () => {
  assert.equal(shouldAutoTitlePrompt(''), false)
  assert.equal(shouldAutoTitlePrompt('   '), false)
  assert.equal(shouldAutoTitlePrompt('/name Custom title'), false)
  assert.equal(shouldAutoTitlePrompt('Fix the settings page'), true)
})

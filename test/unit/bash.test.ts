import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { bashMaxOutputLines, truncateToLastLines } from '../../src/acp/translate/bash.js'

beforeEach(() => {
  delete process.env.PI_ACP_BASH_MAX_OUTPUT_LINES
})

afterEach(() => {
  delete process.env.PI_ACP_BASH_MAX_OUTPUT_LINES
})

test('bashMaxOutputLines: returns undefined by default', () => {
  assert.equal(bashMaxOutputLines(), undefined)
})

test('bashMaxOutputLines: parses positive integer', () => {
  process.env.PI_ACP_BASH_MAX_OUTPUT_LINES = '5'
  assert.equal(bashMaxOutputLines(), 5)
})

test('bashMaxOutputLines: rejects invalid values', () => {
  process.env.PI_ACP_BASH_MAX_OUTPUT_LINES = '0'
  assert.equal(bashMaxOutputLines(), undefined)
  process.env.PI_ACP_BASH_MAX_OUTPUT_LINES = '-1'
  assert.equal(bashMaxOutputLines(), undefined)
  process.env.PI_ACP_BASH_MAX_OUTPUT_LINES = 'abc'
  assert.equal(bashMaxOutputLines(), undefined)
})

test('truncateToLastLines: returns original text when under limit', () => {
  assert.equal(truncateToLastLines('1\n2\n3', 5), '1\n2\n3')
})

test('truncateToLastLines: returns original text when exactly at limit', () => {
  assert.equal(truncateToLastLines('1\n2\n3', 3), '1\n2\n3')
})

test('truncateToLastLines: keeps last N lines with truncation marker', () => {
  assert.equal(truncateToLastLines('1\n2\n3\n4\n5', 2), '... (3 earlier lines truncated)\n4\n5')
})

test('truncateToLastLines: preserves trailing newline', () => {
  assert.equal(truncateToLastLines('1\n2\n3\n4\n5\n', 2), '... (3 earlier lines truncated)\n4\n5\n')
})

test('truncateToLastLines: returns text when maxLines is undefined', () => {
  assert.equal(truncateToLastLines('1\n2\n3\n4\n5'), '1\n2\n3\n4\n5')
})

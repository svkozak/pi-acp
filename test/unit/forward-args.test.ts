import test from 'node:test'
import assert from 'node:assert/strict'
import { getForwardedPiArgs } from '../../src/pi-rpc/forward-args.js'

test('getForwardedPiArgs: forwards unknown long flags', () => {
  assert.deepEqual(getForwardedPiArgs(['--model', 'o4-mini']), ['--model', 'o4-mini'])
})

test('getForwardedPiArgs: strips --terminal-login', () => {
  assert.deepEqual(getForwardedPiArgs(['--terminal-login']), [])
})

test('getForwardedPiArgs: strips --mode and its value', () => {
  assert.deepEqual(getForwardedPiArgs(['--mode', 'cli', '--foo']), ['--foo'])
})

test('getForwardedPiArgs: strips --mode=value form', () => {
  assert.deepEqual(getForwardedPiArgs(['--mode=cli', '--foo']), ['--foo'])
})

test('getForwardedPiArgs: strips --session and its value', () => {
  assert.deepEqual(getForwardedPiArgs(['--session', '/tmp/x', '--foo']), ['--foo'])
})

test('getForwardedPiArgs: strips --session=value form', () => {
  assert.deepEqual(getForwardedPiArgs(['--session=/tmp/x', '--foo']), ['--foo'])
})

test('getForwardedPiArgs: strips --no-themes', () => {
  assert.deepEqual(getForwardedPiArgs(['--no-themes', '--foo']), ['--foo'])
})

test('getForwardedPiArgs: everything after -- forwards unconditionally', () => {
  assert.deepEqual(getForwardedPiArgs(['--mode', 'rpc', '--', '--mode', 'cli']), ['--mode', 'cli'])
})

test('getForwardedPiArgs: returns empty for no args', () => {
  assert.deepEqual(getForwardedPiArgs([]), [])
})

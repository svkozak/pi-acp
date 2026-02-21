import test from 'node:test'
import assert from 'node:assert/strict'
import { toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('toAvailableCommandsFromPiGetCommands: hides extension commands by default and filters skill commands', () => {
  const data = {
    commands: [
      { name: 'x', description: 'X', source: 'extension' },
      { name: 'skill:foo', description: 'Foo', source: 'skill', location: 'user' },
      { name: 'y', source: 'prompt', location: 'project' }
    ]
  }

  const all = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: true }).commands
  assert.deepEqual(all, [
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const includeExt = toAvailableCommandsFromPiGetCommands(data, {
    enableSkillCommands: true,
    includeExtensionCommands: true
  }).commands
  assert.deepEqual(includeExt, [
    { name: 'x', description: 'X' },
    { name: 'skill:foo', description: 'Foo' },
    { name: 'y', description: '(prompt:project)' }
  ])

  const noSkills = toAvailableCommandsFromPiGetCommands(data, { enableSkillCommands: false }).commands
  assert.deepEqual(noSkills, [{ name: 'y', description: '(prompt:project)' }])
})

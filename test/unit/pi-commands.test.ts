import test from 'node:test'
import assert from 'node:assert/strict'
import { isPiExtensionCommand, toAvailableCommandsFromPiGetCommands } from '../../src/acp/pi-commands.js'

test('isPiExtensionCommand: matches exact extension slash commands', () => {
  const commands = {
    commands: [
      { name: 'wt', source: 'extension' },
      { name: 'review', source: 'prompt' }
    ]
  }

  assert.equal(isPiExtensionCommand(commands, '/wt create feature-name'), true)
  assert.equal(isPiExtensionCommand(commands, '/wt-other'), false)
  assert.equal(isPiExtensionCommand(commands, '/review'), false)
  assert.equal(isPiExtensionCommand(commands, ' /wt'), false)
  assert.equal(isPiExtensionCommand({ data: commands }, '/wt'), true)
})

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

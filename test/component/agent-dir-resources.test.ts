import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { PiAcpSession } from '../../src/acp/session.js'
import type { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { expandSlashCommand, loadSlashCommands, toAvailableCommands } from '../../src/acp/slash-commands.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function resourceFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-agent-dir-'))
  const home = join(root, 'home')
  const defaultAgent = join(home, '.pi', 'agent')
  const customAgent = join(root, 'custom-agent')
  const project = join(root, 'project')
  const otherProject = join(root, 'other-project')
  const previousEnv = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PATH: process.env.PATH
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })
  const files = [
    [join(defaultAgent, 'prompts', 'shared.md'), 'Default review for $1'],
    [join(defaultAgent, 'prompts', 'default-only.md'), 'Default-only prompt'],
    [join(defaultAgent, 'extensions', 'default-extension.ts'), ''],
    [join(customAgent, 'prompts', 'shared.md'), 'Custom review for $1'],
    [join(customAgent, 'prompts', 'custom-only.md'), 'Custom-only prompt'],
    [join(customAgent, 'prompts', 'nested', 'nested-review.md'), 'Nested review for $1'],
    [join(customAgent, 'extensions', 'custom-extension.js'), ''],
    [join(project, '.pi', 'prompts', 'shared.md'), 'Project review for $1'],
    [join(project, '.pi', 'prompts', 'project-only.md'), 'Project-only prompt'],
    [join(otherProject, '.pi', 'prompts', 'other-only.md'), 'Other project prompt']
  ]
  for (const [path, content] of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  process.env.HOME = home
  process.env.USERPROFILE = home
  delete process.env.PI_CODING_AGENT_DIR
  // Keep startup version checks offline and independent of installed pi/npm binaries.
  process.env.PATH = ''
  return { root, defaultAgent, customAgent, project, otherProject }
}

// Regressions for the prompt and startup resource paths reported in #167.
test('default agent templates retain user-before-project precedence', t => {
  const { project } = resourceFixture(t)
  const commands = loadSlashCommands(project)
  assert.deepEqual(
    commands.filter(c => c.name === 'shared').map(c => c.source),
    ['(user)', '(project)']
  )
  assert.equal(expandSlashCommand('/shared module-a', commands), 'Default review for module-a')
  assert.equal(expandSlashCommand('/project-only', commands), 'Project-only prompt')
  assert.equal(toAvailableCommands(commands).filter(c => c.name === 'shared').length, 1)
})

test('custom agent templates replace the default directory, including nested templates', t => {
  const { customAgent, project } = resourceFixture(t)
  process.env.PI_CODING_AGENT_DIR = customAgent
  const commands = loadSlashCommands(project)
  assert.equal(expandSlashCommand('/shared module-a', commands), 'Custom review for module-a')
  assert.equal(expandSlashCommand('/custom-only', commands), 'Custom-only prompt')
  assert.equal(expandSlashCommand('/nested-review module-a', commands), 'Nested review for module-a')
  assert.equal(commands.find(c => c.name === 'nested-review')?.source, '(user:nested)')
  assert.equal(expandSlashCommand('/default-only', commands), '/default-only')
  assert.deepEqual(
    commands.filter(c => c.name === 'shared').map(c => c.source),
    ['(user)', '(project)']
  )
})

test('an empty custom template directory keeps project templates without falling back to defaults', t => {
  const { root, project } = resourceFixture(t)
  process.env.PI_CODING_AGENT_DIR = join(root, 'empty-agent')
  const commands = loadSlashCommands(project)
  assert.equal(expandSlashCommand('/shared module-a', commands), 'Project review for module-a')
  assert.equal(expandSlashCommand('/default-only', commands), '/default-only')
})

test('custom agent templates are shared while project templates stay scoped to the requested cwd', t => {
  const { customAgent, project, otherProject } = resourceFixture(t)
  process.env.PI_CODING_AGENT_DIR = customAgent
  const first = loadSlashCommands(project)
  const second = loadSlashCommands(otherProject)
  assert.equal(expandSlashCommand('/project-only', first), 'Project-only prompt')
  assert.equal(expandSlashCommand('/other-only', first), '/other-only')
  assert.equal(expandSlashCommand('/project-only', second), '/project-only')
  assert.equal(expandSlashCommand('/other-only', second), 'Other project prompt')
  assert.equal(expandSlashCommand('/custom-only', second), 'Custom-only prompt')
})

for (const custom of [false, true]) {
  test(`session sends ${custom ? 'custom' : 'default'} template text to the Pi transport`, async t => {
    const { customAgent, project } = resourceFixture(t)
    if (custom) process.env.PI_CODING_AGENT_DIR = customAgent
    const proc = new FakePiRpcProcess()
    const session = new PiAcpSession({
      sessionId: 'template-session',
      cwd: project,
      mcpServers: [],
      proc: proc as unknown as PiRpcProcess,
      conn: asAgentConn(new FakeAgentSideConnection()),
      fileCommands: loadSlashCommands(project)
    })
    const pending = session.prompt('/shared module-a')
    for (const type of ['agent_start', 'turn_end', 'agent_end', 'agent_settled']) proc.emit({ type })
    assert.equal(await pending, 'end_turn')
    assert.deepEqual(
      proc.prompts.map(p => p.message),
      [`${custom ? 'Custom' : 'Default'} review for module-a`]
    )
  })

  for (const section of ['Prompts', 'Extensions']) {
    test(`startup info lists ${section.toLowerCase()} from the ${custom ? 'custom' : 'default'} agent directory`, async t => {
      const { customAgent, defaultAgent, project } = resourceFixture(t)
      if (custom) process.env.PI_CODING_AGENT_DIR = customAgent
      t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)
      const proc = new FakePiRpcProcess()
      t.mock.method(proc, 'getState', async () => ({ thinkingLevel: 'medium' }))
      let emittedStartupInfo: string | undefined
      const session = {
        sessionId: 'startup-session',
        cwd: project,
        proc,
        setStartupInfo(text: string) {
          emittedStartupInfo = text
        },
        sendStartupInfoIfPending() {}
      }
      const agent = new PiAcpAgent(asAgentConn(new FakeAgentSideConnection()))
      Object.defineProperty(agent, 'sessions', {
        value: {
          async create() {
            return session
          }
        }
      })
      const response = await agent.newSession({ cwd: project, mcpServers: [] })
      const startupInfo = response._meta.piAcp.startupInfo
      assert.ok(startupInfo)
      assert.equal(emittedStartupInfo, startupInfo)
      const content = startupInfo.split(`## ${section}\n`)[1]?.split('\n## ')[0]
      assert.ok(content)
      const items = content
        .split('\n')
        .filter(line => line.startsWith('- '))
        .sort()
      const expected =
        section === 'Prompts'
          ? [`- /${custom ? 'custom-only' : 'default-only'}`, '- /shared']
          : [
              `- ${join(custom ? customAgent : defaultAgent, 'extensions', custom ? 'custom-extension.js' : 'default-extension.ts')}`
            ]
      assert.deepEqual(items, expected)
    })
  }
}

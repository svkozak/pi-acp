import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpAgent } from '../../src/acp/agent.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

class FakeSessions<T> {
  constructor(private readonly session: T) {}
  async create() {
    return this.session
  }
  closeAllExcept() {}
}

for (const includeAgentsSkills of [true, false]) {
  test(
    includeAgentsSkills
      ? 'PiAcpAgent: startup info lists project .agents/skills alongside .pi/skills'
      : 'PiAcpAgent: startup info lists .pi/skills when project .agents/skills is absent',
    async t => {
      const root = mkdtempSync(join(tmpdir(), 'pi-acp-project-skills-'))
      const previousEnv = {
        HOME: process.env.HOME,
        PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
        PATH: process.env.PATH
      }
      const timeoutMock = t.mock.method(globalThis, 'setTimeout', () => 0 as unknown as ReturnType<typeof setTimeout>)

      try {
        process.env.HOME = join(root, 'home')
        process.env.PI_CODING_AGENT_DIR = join(root, 'agent')
        // Prevent startup version checks from invoking pi or npm on the host.
        process.env.PATH = ''
        mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true })
        writeFileSync(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'), '{"quietStartup":false}')

        const projectDir = join(root, 'project')
        const piSkill = join(projectDir, '.pi', 'skills', 'existing-skill', 'SKILL.md')
        const agentsSkill = join(projectDir, '.agents', 'skills', 'web-api-design', 'SKILL.md')
        const expectedSkills = includeAgentsSkills ? [piSkill, agentsSkill] : [piSkill]
        for (const path of expectedSkills) {
          mkdirSync(join(path, '..'), { recursive: true })
          writeFileSync(path, '---\nname: example\ndescription: Example skill for startup tests\n---\n')
        }

        const conn = new FakeAgentSideConnection()
        let emittedStartupInfo: string | undefined
        const session = {
          sessionId: 'project-skills',
          cwd: projectDir,
          proc: {
            async getAvailableModels() {
              return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
            },
            async getState() {
              return { thinkingLevel: 'medium', model: { provider: 'test', id: 'model' } }
            },
            async getCommands() {
              return { commands: [] }
            }
          },
          setStartupInfo(text: string) {
            emittedStartupInfo = text
          },
          sendStartupInfoIfPending() {}
        }
        const agent = new PiAcpAgent(asAgentConn(conn), {})
        Object.defineProperty(agent, 'sessions', { value: new FakeSessions(session) })

        const response = await agent.newSession({ cwd: projectDir, mcpServers: [] })
        const startupInfo = response._meta.piAcp.startupInfo
        assert.equal(typeof startupInfo, 'string')
        assert.equal(emittedStartupInfo, startupInfo)
        const skillsSection = startupInfo?.split('## Skills\n')[1]?.split('\n## ')[0]
        assert.ok(skillsSection, 'startup message must contain a Skills section')
        const listedSkills = skillsSection.split('\n').filter(line => line.startsWith('- '))
        assert.deepEqual(
          listedSkills,
          expectedSkills.map(path => `- ${path}`)
        )
      } finally {
        timeoutMock.mock.restore()
        for (const [key, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
}

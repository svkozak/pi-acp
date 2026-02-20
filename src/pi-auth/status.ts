import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function safeReadJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf-8')
    if (!raw.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function getPiAgentDir(): string {
  // pi-mono uses ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`.
  // Default APP_NAME is "pi".
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) {
    if (envDir === '~') return homedir()
    if (envDir.startsWith('~/')) return homedir() + envDir.slice(1)
    return envDir
  }
  return join(homedir(), '.pi', 'agent')
}

export function hasAnyPiAuthConfigured(): boolean {
  // 1) auth.json present and non-empty (api keys or oauth creds)
  const agentDir = getPiAgentDir()
  const authPath = join(agentDir, 'auth.json')
  const auth = safeReadJson(authPath)
  if (auth && typeof auth === 'object' && Object.keys(auth).length > 0) return true

  // 2) models.json with custom provider apiKey configured
  const modelsPath = join(agentDir, 'models.json')
  const models = safeReadJson(modelsPath)
  const providers = models?.providers
  if (providers && typeof providers === 'object') {
    for (const p of Object.values(providers as Record<string, any>)) {
      if (p && typeof p === 'object' && typeof (p as any).apiKey === 'string' && (p as any).apiKey.trim()) {
        // Note: pi treats a non-empty string as either env-var name OR literal secret.
        // So presence of apiKey config is enough to be considered "auth configured".
        return true
      }
    }
  }

  // 3) Known provider env vars (mirrors pi-ai getEnvApiKey mapping)
  const envVars = [
    'OPENAI_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'CEREBRAS_API_KEY',
    'XAI_API_KEY',
    'OPENROUTER_API_KEY',
    'AI_GATEWAY_API_KEY',
    'ZAI_API_KEY',
    'MISTRAL_API_KEY',
    'MINIMAX_API_KEY',
    'MINIMAX_CN_API_KEY',
    'HF_TOKEN',
    'OPENCODE_API_KEY',
    'KIMI_API_KEY',
    // Copilot/github
    'COPILOT_GITHUB_TOKEN',
    'GH_TOKEN',
    'GITHUB_TOKEN',
    // Anthropic oauth
    'ANTHROPIC_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY'
  ]

  for (const k of envVars) {
    const v = process.env[k]
    if (typeof v === 'string' && v.trim()) return true
  }

  return false
}

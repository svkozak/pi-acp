import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { bridgeToolName, schemaToTypebox, type BridgeServerPlan } from './servers.js'

/** The slice of pi's ExtensionAPI the bridge needs; keeps the unit tests SDK-pure. */
export type BridgeToolRegistrar = Pick<ExtensionAPI, 'registerTool'>

/**
 * List a connected MCP client's tools and register each on pi under the
 * bridge's `${server}_${tool}` name. Returns the names it registered.
 */
export async function registerBridgeTools(
  pi: BridgeToolRegistrar,
  client: Client,
  plan: BridgeServerPlan
): Promise<string[]> {
  const { tools } = await client.listTools()
  const names: string[] = []
  for (const tool of tools) {
    const name = bridgeToolName(plan.server, tool.name)
    names.push(name)
    pi.registerTool({
      name,
      label: `${plan.server}: ${tool.name}`,
      description: tool.description ?? `${tool.name} from ${plan.server}`,
      parameters: schemaToTypebox(tool.inputSchema),
      async execute(_toolCallId, args) {
        const answer = await client.callTool({
          name: tool.name,
          arguments: (args ?? {}) as Record<string, unknown>
        })
        return { content: [{ type: 'text', text: bridgeAnswerText(answer) }], details: undefined }
      }
    })
  }
  return names
}

/** The long text of an MCP content array: text parts joined, the rest named. */
export function bridgeAnswerText(answer: unknown): string {
  const record = (answer ?? {}) as { content?: unknown; isError?: unknown }
  const parts = Array.isArray(record.content) ? record.content : []
  const texts = parts
    .map(part => {
      const p = part as { type?: unknown; text?: unknown }
      return p?.type === 'text' ? String(p.text ?? '') : `[${String(p?.type ?? 'part')}]`
    })
    .join('\n')
  if (record.isError) return `The tool answered an error:\n${texts}`
  return texts || '(the tool answered with no content)'
}

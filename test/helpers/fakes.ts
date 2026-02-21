import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { PiRpcEvent } from '../../src/pi-rpc/process.js'

type SessionUpdateMsg = Parameters<AgentSideConnection['sessionUpdate']>[0]

export class FakeAgentSideConnection {
  readonly updates: SessionUpdateMsg[] = []

  async sessionUpdate(msg: SessionUpdateMsg): Promise<void> {
    this.updates.push(msg)
  }
}

export class FakePiRpcProcess {
  private handlers: Array<(ev: PiRpcEvent) => void> = []

  // spies
  readonly prompts: Array<{ message: string; attachments: unknown[] }> = []
  abortCount = 0

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter(h => h !== handler)
    }
  }

  emit(ev: PiRpcEvent) {
    for (const h of this.handlers) h(ev)
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    this.prompts.push({ message, attachments })
  }

  async abort(): Promise<void> {
    this.abortCount += 1
  }


  async getState(): Promise<any> {
    return {}
  }

  async getAvailableModels(): Promise<any> {
    return { models: [{ provider: 'test', id: 'model', name: 'model' }] }
  }

  async getMessages(): Promise<any> {
    return { messages: [] }
  }
}

export function asAgentConn(conn: FakeAgentSideConnection): AgentSideConnection {
  // We only implement the method(s) used by PiAcpSession in tests.
  return conn as unknown as AgentSideConnection
}

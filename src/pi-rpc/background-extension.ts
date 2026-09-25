import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  BACKGROUND_COMMAND,
  BACKGROUND_STATUS_KEY,
  type BackgroundJob,
  type BackgroundMessage
} from './background-protocol.js'

interface Context {
  mode: string
  ui: { setStatus(key: string, text: string | undefined): void }
  sessionManager: { getSessionFile(): string | null | undefined }
  isIdle(): boolean
  hasPendingMessages(): boolean
  abort(): void | Promise<void>
}

interface ExtensionApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx: Context) => unknown): void
  registerCommand(
    name: string,
    options: {
      description: string
      handler(args: string, ctx: Context & { waitForIdle(): Promise<void> }): Promise<void>
    }
  ): void
  events: {
    on(event: string, handler: (data: unknown) => void): () => void
    emit(event: string, data: unknown): void
  }
}

interface OwnedJob {
  job: BackgroundJob
  delivered: boolean
  proof?: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const CANCEL_TIMEOUT_MS = 12_000

export default function backgroundExtension(pi: ExtensionApi): void {
  const owner = process.env.PI_ACP_BACKGROUND_BRIDGE
  if (owner !== '1' && owner !== String(process.pid)) return
  // Reloads retain ownership; inherited extensions in another process do not.
  process.env.PI_ACP_BACKGROUND_BRIDGE = String(process.pid)

  let context: Context | undefined
  let cancelling = false
  let cancellation: Promise<void> | undefined
  let capability: Promise<void> | undefined
  const owned = new Map<string, OwnedJob>()
  const completed = new Set<string>()
  const unsubscribers: Array<() => void> = []
  let wake: (() => void) | undefined

  function send(message: BackgroundMessage): void {
    context?.ui.setStatus(BACKGROUND_STATUS_KEY, JSON.stringify(message))
  }

  function snapshot(finished?: Extract<BackgroundMessage, { type: 'snapshot' }>['finished']): void {
    if (!context) return
    send({
      version: 1,
      type: 'snapshot',
      active: [...owned.values()].filter(item => !item.delivered).map(item => item.job),
      idle: !cancelling && context.isIdle() && !context.hasPendingMessages(),
      ...(finished ? { finished } : {})
    })
  }

  function register(data: Record<string, unknown>, id: string): void {
    if (owned.has(id)) return
    const job: BackgroundJob = {
      id,
      title: typeof data.agent === 'string' ? data.agent : typeof data.mode === 'string' ? data.mode : 'Subagent',
      ...(typeof data.asyncDir === 'string' ? { asyncDir: data.asyncDir } : {}),
      ...(typeof data.mode === 'string' ? { mode: data.mode } : {})
    }
    owned.set(id, { job, delivered: completed.has(id) })
    snapshot()
    wake?.()
  }

  function acceptProof(value: unknown): void {
    const proof = record(value)
    if (!proof || proof.version !== 1 || typeof proof.runId !== 'string') return
    const item = owned.get(proof.runId)
    if (!item || typeof proof.state !== 'string') return
    item.proof = proof.state
    if (!cancelling && item.delivered && proof.state === 'observed') owned.delete(proof.runId)
    wake?.()
  }

  function rpc(method: string, id: string | undefined, deadline: number): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const unsubscribe = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, value => {
        const reply = record(value)
        if (reply?.version !== 1 || reply.requestId !== requestId) return
        clearTimeout(timer)
        unsubscribe()
        if (reply.success === true) resolve(record(reply.data) ?? {})
        else reject(new Error(String(record(reply.error)?.message ?? `Subagent ${method} failed`)))
      })
      const timer = setTimeout(
        () => {
          unsubscribe()
          reject(new Error(`Subagent ${method} timed out for ${id}`))
        },
        Math.max(1, deadline - Date.now())
      )
      pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method, params: id ? { id } : {} })
    })
  }

  async function workflowRetired(item: OwnedJob): Promise<boolean> {
    if (!item.delivered || !item.job.asyncDir) return false
    const status = record(JSON.parse(await readFile(join(item.job.asyncDir, 'status.json'), 'utf8')))
    if (
      status?.runId !== item.job.id ||
      status.sessionId !== context?.sessionManager.getSessionFile() ||
      status.mode !== 'workflow'
    ) {
      throw new Error('Workflow status identity does not match its owner')
    }
    if (!['complete', 'failed', 'stopped', 'paused', 'partial', 'rejected'].includes(String(status.state))) return false
    if (!Array.isArray(status.steps)) throw new Error('Workflow child inventory is unavailable')
    for (const value of status.steps) {
      const step = record(value)
      if (typeof step?.async !== 'boolean') throw new Error('Workflow child async classification is unavailable')
      if (!step.async) continue
      if (typeof step.runId !== 'string' || basename(step.runId) !== step.runId)
        throw new Error('Workflow child run identity is unavailable')
      const childDir = join(dirname(item.job.asyncDir), step.runId)
      const child = record(JSON.parse(await readFile(join(childDir, 'status.json'), 'utf8')))
      let proof: Record<string, unknown> | undefined
      try {
        proof = record(JSON.parse(await readFile(join(childDir, 'process-terminal.json'), 'utf8')))
      } catch (error) {
        if (record(error)?.code === 'ENOENT') return false
        throw error
      }
      const instance = record(child?.processTerminal)?.runnerProcessInstanceId
      if (
        child?.runId !== step.runId ||
        child.sessionId !== status.sessionId ||
        typeof instance !== 'string' ||
        proof?.version !== 1 ||
        proof.runId !== step.runId ||
        proof.runnerProcessInstanceId !== instance
      ) {
        throw new Error('Workflow child process proof identity does not match its owner')
      }
      if (proof.state === 'unknown') throw new Error('Workflow child process termination is unknown')
      if (proof.state !== 'observed' && proof.state !== 'not-started') return false
    }
    // Delivery runs through the async watcher after the workflow's synchronous finally
    // retires its controller. Terminal status alone cannot establish that ordering.
    return true
  }

  async function cancel(ctx: Context & { waitForIdle(): Promise<void> }): Promise<void> {
    cancelling = true
    snapshot()
    const deadline = Date.now() + CANCEL_TIMEOUT_MS
    const stopped = new Set<string>()
    const failures = new Map<string, string>()
    let parentDrained = false
    try {
      void Promise.resolve()
        .then(() => ctx.abort())
        .then(() => ctx.waitForIdle())
        .catch(error => {
          failures.set('parent', String(error))
        })
        .finally(() => {
          parentDrained = true
          wake?.()
        })
      while (true) {
        const jobs = [...owned.values()].filter(item => item.proof !== 'observed' && item.proof !== 'not-started')
        await Promise.all(
          jobs
            .filter(item => !item.delivered && !stopped.has(item.job.id))
            .map(async item => {
              stopped.add(item.job.id)
              try {
                await rpc('stop', item.job.id, deadline)
              } catch (error) {
                failures.set(item.job.id, String(error))
              }
            })
        )
        await Promise.all(
          jobs
            .filter(item => !failures.has(item.job.id))
            .map(async item => {
              if (item.proof === 'observed' || item.proof === 'not-started') return
              try {
                const status = await rpc('status', item.job.id, deadline)
                acceptProof(record(record(status.details)?.lifecycleStatus)?.processTerminal)
                if (item.job.mode === 'workflow') {
                  if (await workflowRetired(item)) item.proof = 'observed'
                } else if (item.proof === 'unknown') {
                  failures.set(item.job.id, 'Subagent process termination is unknown')
                }
              } catch (error) {
                failures.set(item.job.id, String(error))
              }
            })
        )
        const pending = [...owned.values()].filter(
          item => item.proof !== 'observed' && item.proof !== 'not-started' && !failures.has(item.job.id)
        )
        if (pending.length === 0 && parentDrained) break
        if (Date.now() >= deadline) {
          if (!parentDrained) failures.set('parent', 'Timed out waiting for parent tools to stop')
          for (const item of pending) failures.set(item.job.id, 'Timed out waiting for observed process termination')
          break
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(
            () => {
              wake = undefined
              resolve()
            },
            Math.min(100, deadline - Date.now())
          )
          wake = () => {
            clearTimeout(timer)
            wake = undefined
            resolve()
          }
        })
      }
      const error = [...failures].map(([id, message]) => `${id}: ${message}`).join('; ')
      send({ version: 1, type: 'cancelled', ...(error ? { error } : {}) })
    } catch (error) {
      send({ version: 1, type: 'cancelled', error: String(error) })
    }
    // The adapter retires this process. Keep tools blocked until it exits.
  }

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'rpc') return
    context = ctx
    send({ version: 1, type: 'ready' })
    snapshot()
  })
  for (const event of ['agent_start', 'agent_settled']) {
    pi.on(event, (_event, ctx) => {
      if (ctx.mode !== 'rpc' || !context) return
      context = ctx
      snapshot()
    })
  }
  pi.on('tool_call', event => {
    if (cancelling) return { block: true, reason: 'ACP operation is being cancelled' }
    if (event.toolName !== 'subagent') return
    capability ??= rpc('ping', undefined, Date.now() + 2_000).then(reply => {
      const caps = record(reply.capabilities)
      if (
        caps?.stop !== true ||
        record(caps.processTerminalProof)?.version !== 1 ||
        record(reply.events)?.asyncComplete !== 'subagent:async-complete'
      ) {
        throw new Error('pi-subagents does not support the required background lifecycle contract')
      }
    })
    return capability
      .then(() => (cancelling ? { block: true, reason: 'ACP operation is being cancelled' } : undefined))
      .catch(error => {
        cancelling = true
        const reason = `Background lifecycle unavailable: ${String(error)}`
        send({ version: 1, type: 'error', message: reason })
        return { block: true, reason }
      })
  })
  pi.on('tool_result', (event, ctx) => {
    if (ctx.mode !== 'rpc' || !context || event.toolName !== 'subagent') return
    const details = record(event.details)
    if (details && typeof details.asyncId === 'string' && details.asyncId === details.runId)
      register(details, details.asyncId)
  })
  unsubscribers.push(
    pi.events.on('subagent:async-started', value => {
      const data = record(value)
      if (
        !context ||
        !data ||
        data.sessionId !== context.sessionManager.getSessionFile() ||
        typeof data.id !== 'string'
      )
        return
      register(data, data.id)
    })
  )
  unsubscribers.push(
    pi.events.on('subagent:async-complete', value => {
      const data = record(value)
      if (
        !context ||
        !data ||
        data.sessionId !== context.sessionManager.getSessionFile() ||
        typeof data.runId !== 'string'
      )
        return
      if (completed.has(data.runId)) return
      const item = owned.get(data.runId)
      completed.add(data.runId)
      if (item) {
        item.delivered = true
        if (!cancelling && item.proof === 'observed') owned.delete(data.runId)
      }
      snapshot({
        id: data.runId,
        title:
          item?.job.title ??
          (typeof data.agent === 'string' ? data.agent : typeof data.mode === 'string' ? data.mode : 'Subagent'),
        status: data.success === false ? 'failed' : 'completed',
        ...(typeof data.summary === 'string' ? { text: data.summary } : {})
      })
      wake?.()
    })
  )
  unsubscribers.push(pi.events.on('subagent:process-terminal', acceptProof))
  pi.on('session_shutdown', () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  })
  pi.registerCommand(BACKGROUND_COMMAND, {
    description: 'Internal ACP background lifecycle control',
    async handler(args, ctx) {
      if (ctx.mode !== 'rpc' || !context) return
      if (args.trim() !== 'cancel') {
        send({ version: 1, type: 'error', message: 'Unknown background lifecycle command' })
        return
      }
      cancellation ??= cancel(ctx)
      await cancellation
    }
  })
}
